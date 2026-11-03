module pcie_frame_dma_v2 #(
    parameter integer CLK_HZ = 125000000,
    parameter integer TARGET_FPS = 30
)(
    input               clk,
    input               rst_n,

    input               bar_wr_en,
    input      [11:0]   bar_wr_addr,
    input      [127:0]  bar_wr_data,
    input      [15:0]   bar_wr_byte_en,
    input               bar_rd_clk_en,
    input      [11:0]   bar_rd_addr,
    output reg          bar_rd_override,
    output reg [127:0]  bar_rd_data,

    input      [3:0]    source_valid_async,
    input      [3:0]    snapshot_ack_async,
    input      [3:0]    read_complete_async,
    input      [10:0]   ch0_fifo_level,
    input      [10:0]   ch1_fifo_level,
    input      [10:0]   ch2_fifo_level,
    input      [10:0]   ch3_fifo_level,
    input               stream_underflow,
    output reg          frame_snapshot_req,
    output wire [3:0]   frame_source_mask,
    output wire [3:0]   snapshot_drain_mask,
    output wire         active,

    output wire         auto_mwr_req,
    output wire [9:0]   auto_mwr_length,
    output wire [31:0]  auto_mwr_addr,
    input               auto_mwr_req_ack,
    input               auto_mwr_done,
    input               auto_mwr_busy,

    input      [11:0]   dma_data_addr,
    output wire         metadata_mode,
    output reg [127:0]  metadata_data,

    output reg          irq_pulse
);

localparam [31:0] V2_MAGIC = 32'h324d5246;
localparam [31:0] V2_VERSION = 32'h00020001;
localparam [31:0] V2_CAPABILITIES = 32'h000002a7;
localparam [31:0] V2_BUILD_ID = 32'h00080001;
localparam [31:0] FRAME_WIDTH = 32'd1280;
localparam [31:0] FRAME_HEIGHT = 32'd720;
localparam [31:0] FRAME_STRIDE = 32'd2560;
localparam [31:0] FRAME_BYTES = 32'h001c2000;
localparam [31:0] META_BYTES = 32'd256;
localparam [31:0] TIMESTAMP_HZ = CLK_HZ;
localparam [31:0] TARGET_FPS_MILLI = TARGET_FPS * 1000;
// A zero PCIe length field represents 1024 DWORDs.  The DMA transport widens
// that encoding internally, so one 4KB-aligned request is issued per chunk.
localparam integer PAYLOAD_CHUNKS = 450;

localparam [3:0] ST_IDLE              = 4'd0;
localparam [3:0] ST_SNAPSHOT          = 4'd1;
localparam [3:0] ST_WAIT_FIFO         = 4'd2;
localparam [3:0] ST_PAYLOAD_REQ       = 4'd3;
localparam [3:0] ST_PAYLOAD_WAIT      = 4'd4;
localparam [3:0] ST_META_REQ          = 4'd5;
localparam [3:0] ST_META_WAIT         = 4'd6;
localparam [3:0] ST_COMPLETE          = 4'd7;
localparam [3:0] ST_ABORT_WAIT        = 4'd8;
localparam [3:0] ST_PUBLISH_WAIT      = 4'd9;
// The vendor done pulse marks acceptance by the local PCIe transmit path. Give
// the final posted metadata write time to drain before BAR DONE and MSI expose
// the buffer to RK. 1024 clocks is 8.192 us at 125 MHz and does not affect the
// fixed 30 Hz frame cadence.
localparam [10:0] META_PUBLISH_GUARD = 11'd1024;

reg [3:0] state;
reg       enable_reg;
reg       claimed_reg;
reg       irq_enable_reg;
reg       crc_enable_reg;
reg       config_ok;
reg       running;
reg       stop_pending;
reg       reset_pending;

reg [31:0] cfg_width;
reg [31:0] cfg_height;
reg [31:0] cfg_stride;
reg [31:0] cfg_pixel_format;
reg [31:0] cfg_frame_bytes;
reg [31:0] cfg_source_layout;
reg [31:0] cfg_source_map;
reg [31:0] cfg_ring_count;
reg [31:0] cfg_meta_offset;

reg [31:0] buf0_addr_lo;
reg [31:0] buf0_addr_hi;
reg [31:0] buf0_capacity;
reg [31:0] buf1_addr_lo;
reg [31:0] buf1_addr_hi;
reg [31:0] buf1_capacity;
reg [31:0] buf2_addr_lo;
reg [31:0] buf2_addr_hi;
reg [31:0] buf2_capacity;
reg [31:0] buf3_addr_lo;
reg [31:0] buf3_addr_hi;
reg [31:0] buf3_capacity;

reg [3:0]  free_bitmap;
reg [3:0]  done_bitmap;
reg [31:0] irq_status;
reg [31:0] irq_mask;
reg [31:0] drop_count;
reg [31:0] error_code;
reg [63:0] producer_seq;
reg [63:0] timestamp_counter;
reg [63:0] last_timestamp;
reg [31:0] last_done_index;
reg [31:0] writing_index;

reg [1:0]  active_buffer_index;
reg [31:0] active_buffer_addr;
reg [63:0] active_frame_seq;
reg [63:0] active_timestamp;
reg [1:0]  allocation_cursor;
reg [10:0] payload_chunk;
reg [11:0] stream_row;
reg [8:0]  stream_col;

reg [3:0] snapshot_ack_seen;
reg [3:0] read_complete_low_seen;
reg [3:0] read_complete_seen;
reg [31:0] frame_phase;
reg [3:0] active_source_mask;
reg [10:0] publish_guard_count;

reg [3:0] source_valid_meta;
reg [3:0] source_valid_sync;
reg [3:0] snapshot_ack_meta;
reg [3:0] snapshot_ack_sync;
reg [3:0] read_complete_meta;
reg [3:0] read_complete_sync;

wire bar_word_write = bar_wr_en && (|bar_wr_byte_en[3:0]);
wire [31:0] bar_write_value = bar_wr_data[31:0];
wire control_write = bar_word_write && (bar_wr_addr == 12'h210);
wire control_start = control_write && bar_write_value[1];
wire control_stop = control_write && bar_write_value[2];
wire control_reset = control_write && bar_write_value[3];
wire control_commit = control_write && bar_write_value[8];
wire stop_requested = control_stop || stop_pending;

wire [3:0] ring_mask =
    (cfg_ring_count == 32'd2) ? 4'b0011 :
    (cfg_ring_count == 32'd3) ? 4'b0111 :
    (cfg_ring_count == 32'd4) ? 4'b1111 : 4'b0000;

wire buf0_valid = (buf0_addr_hi == 32'd0) &&
                  (buf0_addr_lo[11:0] == 12'd0) &&
                  (buf0_capacity >= cfg_meta_offset + META_BYTES);
wire buf1_valid = (buf1_addr_hi == 32'd0) &&
                  (buf1_addr_lo[11:0] == 12'd0) &&
                  (buf1_capacity >= cfg_meta_offset + META_BYTES);
wire buf2_valid = (buf2_addr_hi == 32'd0) &&
                  (buf2_addr_lo[11:0] == 12'd0) &&
                  (buf2_capacity >= cfg_meta_offset + META_BYTES);
wire buf3_valid = (buf3_addr_hi == 32'd0) &&
                  (buf3_addr_lo[11:0] == 12'd0) &&
                  (buf3_capacity >= cfg_meta_offset + META_BYTES);

wire buffers_valid = buf0_valid && buf1_valid &&
                     ((cfg_ring_count < 32'd3) || buf2_valid) &&
                     ((cfg_ring_count < 32'd4) || buf3_valid);

wire configuration_valid =
    (cfg_width == FRAME_WIDTH) &&
    (cfg_height == FRAME_HEIGHT) &&
    (cfg_stride == FRAME_STRIDE) &&
    (cfg_pixel_format == 32'd1) &&
    (cfg_frame_bytes == FRAME_BYTES) &&
    (cfg_source_layout == 32'd1) &&
    (cfg_source_map == 32'h00003210) &&
    (cfg_ring_count >= 32'd2) &&
    (cfg_ring_count <= 32'd4) &&
    (cfg_meta_offset == FRAME_BYTES) &&
    (cfg_meta_offset[7:0] == 8'd0) &&
    buffers_valid;

wire frame_tick = running &&
                  (frame_phase >= (CLK_HZ - TARGET_FPS));
wire dma_engine_busy = (state != ST_IDLE);
wire source_ready_sync = |source_valid_sync;
wire [31:0] status_value =
    32'h00000001 |
    (config_ok ? 32'h00000002 : 32'd0) |
    (running ? 32'h00000004 : 32'd0) |
    (dma_engine_busy ? 32'h00000008 : 32'd0) |
    ((running && ((free_bitmap & ring_mask) == 4'd0)) ? 32'h00000010 : 32'd0) |
    (source_ready_sync ? 32'h00000020 : 32'd0) |
    ((!running && !dma_engine_busy && !auto_mwr_busy) ? 32'h00000040 : 32'd0) |
    ((error_code != 32'd0) ? 32'h80000000 : 32'd0);

function [1:0] choose_free_buffer;
    input [3:0] available;
    input [1:0] cursor;
    integer offset;
    reg found;
    reg [1:0] candidate;
    begin
        choose_free_buffer = 2'd0;
        found = 1'b0;
        for (offset = 1; offset <= 4; offset = offset + 1) begin
            candidate = cursor + offset;
            if (!found && available[candidate]) begin
                choose_free_buffer = candidate;
                found = 1'b1;
            end
        end
    end
endfunction

wire [3:0] available_buffers = free_bitmap & ring_mask;
wire [1:0] next_buffer_index =
    choose_free_buffer(available_buffers, allocation_cursor);

function [31:0] buffer_address;
    input [1:0] index;
    begin
        case (index)
            2'd0: buffer_address = buf0_addr_lo;
            2'd1: buffer_address = buf1_addr_lo;
            2'd2: buffer_address = buf2_addr_lo;
            2'd3: buffer_address = buf3_addr_lo;
            default: buffer_address = 32'd0;
        endcase
    end
endfunction

wire chunk_crosses_row =
    ({1'b0, stream_col} + 10'd256 > 10'd160);
wire [9:0] stream_col_advance = {1'b0, stream_col} + 10'd256;
wire need_top_pair = (stream_row < 12'd360);
wire need_bottom_pair = (stream_row >= 12'd360) ||
                        ((stream_row == 12'd359) && chunk_crosses_row);
wire ch0_ready = !active_source_mask[0] ||
                 (ch0_fifo_level >= 11'd160) ||
                 (read_complete_seen[0] && (ch0_fifo_level != 11'd0));
wire ch1_ready = !active_source_mask[1] ||
                 (ch1_fifo_level >= 11'd160) ||
                 (read_complete_seen[1] && (ch1_fifo_level != 11'd0));
wire ch2_ready = !active_source_mask[2] ||
                 (ch2_fifo_level >= 11'd160) ||
                 (read_complete_seen[2] && (ch2_fifo_level != 11'd0));
wire ch3_ready = !active_source_mask[3] ||
                 (ch3_fifo_level >= 11'd160) ||
                 (read_complete_seen[3] && (ch3_fifo_level != 11'd0));
wire chunk_data_ready = (!need_top_pair || (ch0_ready && ch1_ready)) &&
                        (!need_bottom_pair || (ch2_ready && ch3_ready));

// Reading the capability block does not disturb the legacy V1 path.  Once
// software writes V2_CONTROL, keep ownership until the next FPGA reset so a
// legacy prefetch cannot occupy the DDR readers between RESET and START.
assign active = claimed_reg;
assign frame_source_mask = active_source_mask;
// A previous V1 transfer or an interrupted V2 frame can leave a DDR reader
// blocked behind a full FIFO. Drain each stale reader only until its new
// snapshot request is acknowledged; channels that ACK early must retain their
// newly selected frame while the remaining channels finish the handoff.
assign snapshot_drain_mask = (state == ST_SNAPSHOT) ?
    ~(snapshot_ack_seen | snapshot_ack_sync) : 4'd0;
assign auto_mwr_req = (state == ST_PAYLOAD_REQ) || (state == ST_META_REQ);
assign auto_mwr_length = (state == ST_META_REQ || state == ST_META_WAIT) ?
                         10'd64 : 10'd0;
assign auto_mwr_addr = (state == ST_META_REQ || state == ST_META_WAIT) ?
                       active_buffer_addr + cfg_meta_offset :
                       active_buffer_addr + {payload_chunk, 12'd0};
assign metadata_mode = (state == ST_META_REQ) || (state == ST_META_WAIT);

always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        source_valid_meta <= 4'd0;
        source_valid_sync <= 4'd0;
        snapshot_ack_meta <= 4'd0;
        snapshot_ack_sync <= 4'd0;
        read_complete_meta <= 4'd0;
        read_complete_sync <= 4'd0;
    end
    else begin
        source_valid_meta <= source_valid_async;
        source_valid_sync <= source_valid_meta;
        snapshot_ack_meta <= snapshot_ack_async;
        snapshot_ack_sync <= snapshot_ack_meta;
        read_complete_meta <= read_complete_async;
        read_complete_sync <= read_complete_meta;
    end
end

always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        state <= ST_IDLE;
        enable_reg <= 1'b0;
        claimed_reg <= 1'b0;
        irq_enable_reg <= 1'b0;
        crc_enable_reg <= 1'b0;
        config_ok <= 1'b0;
        running <= 1'b0;
        stop_pending <= 1'b0;
        reset_pending <= 1'b0;
        cfg_width <= FRAME_WIDTH;
        cfg_height <= FRAME_HEIGHT;
        cfg_stride <= FRAME_STRIDE;
        cfg_pixel_format <= 32'd1;
        cfg_frame_bytes <= FRAME_BYTES;
        cfg_source_layout <= 32'd1;
        cfg_source_map <= 32'h00003210;
        cfg_ring_count <= 32'd3;
        cfg_meta_offset <= FRAME_BYTES;
        buf0_addr_lo <= 32'd0;
        buf0_addr_hi <= 32'd0;
        buf0_capacity <= 32'd0;
        buf1_addr_lo <= 32'd0;
        buf1_addr_hi <= 32'd0;
        buf1_capacity <= 32'd0;
        buf2_addr_lo <= 32'd0;
        buf2_addr_hi <= 32'd0;
        buf2_capacity <= 32'd0;
        buf3_addr_lo <= 32'd0;
        buf3_addr_hi <= 32'd0;
        buf3_capacity <= 32'd0;
        free_bitmap <= 4'd0;
        done_bitmap <= 4'd0;
        irq_status <= 32'd0;
        irq_mask <= 32'd0;
        drop_count <= 32'd0;
        error_code <= 32'd0;
        producer_seq <= 64'd0;
        timestamp_counter <= 64'd0;
        last_timestamp <= 64'd0;
        last_done_index <= 32'hffffffff;
        writing_index <= 32'hffffffff;
        active_buffer_index <= 2'd0;
        active_buffer_addr <= 32'd0;
        active_frame_seq <= 64'd0;
        active_timestamp <= 64'd0;
        allocation_cursor <= 2'd3;
        payload_chunk <= 11'd0;
        stream_row <= 12'd0;
        stream_col <= 9'd0;
        snapshot_ack_seen <= 4'd0;
        read_complete_low_seen <= 4'd0;
        read_complete_seen <= 4'd0;
        frame_phase <= 32'd0;
        active_source_mask <= 4'd0;
        publish_guard_count <= 11'd0;
        frame_snapshot_req <= 1'b0;
        irq_pulse <= 1'b0;
    end
    else begin
        timestamp_counter <= timestamp_counter + 64'd1;
        irq_pulse <= 1'b0;

        if (!running)
            frame_phase <= 32'd0;
        else if (frame_tick)
            frame_phase <= frame_phase - (CLK_HZ - TARGET_FPS);
        else
            frame_phase <= frame_phase + TARGET_FPS;

        if (bar_word_write) begin
            case (bar_wr_addr)
                12'h218: irq_status <= irq_status & ~bar_write_value;
                12'h21c: irq_mask <= bar_write_value;
                12'h220: cfg_width <= bar_write_value;
                12'h224: cfg_height <= bar_write_value;
                12'h228: cfg_stride <= bar_write_value;
                12'h22c: cfg_pixel_format <= bar_write_value;
                12'h230: cfg_frame_bytes <= bar_write_value;
                12'h234: cfg_source_layout <= bar_write_value;
                12'h238: cfg_source_map <= bar_write_value;
                12'h23c: cfg_ring_count <= bar_write_value;
                12'h240: cfg_meta_offset <= bar_write_value;
                12'h26c: begin
                    done_bitmap <= done_bitmap & ~bar_write_value[3:0];
                    free_bitmap <= free_bitmap |
                                   (bar_write_value[3:0] & ring_mask);
                end
                12'h280: buf0_addr_lo <= bar_write_value;
                12'h284: buf0_addr_hi <= bar_write_value;
                12'h288: buf0_capacity <= bar_write_value;
                12'h290: buf1_addr_lo <= bar_write_value;
                12'h294: buf1_addr_hi <= bar_write_value;
                12'h298: buf1_capacity <= bar_write_value;
                12'h2a0: buf2_addr_lo <= bar_write_value;
                12'h2a4: buf2_addr_hi <= bar_write_value;
                12'h2a8: buf2_capacity <= bar_write_value;
                12'h2b0: buf3_addr_lo <= bar_write_value;
                12'h2b4: buf3_addr_hi <= bar_write_value;
                12'h2b8: buf3_capacity <= bar_write_value;
                default: begin end
            endcase
        end

        if (control_write) begin
            claimed_reg <= 1'b1;
            enable_reg <= bar_write_value[0];
            irq_enable_reg <= bar_write_value[4];
            crc_enable_reg <= bar_write_value[5];
        end

        if (control_reset) begin
            running <= 1'b0;
            stop_pending <= 1'b0;
            config_ok <= 1'b0;
            irq_status <= 32'd0;
            drop_count <= 32'd0;
            error_code <= 32'd0;
            producer_seq <= 64'd0;
            last_timestamp <= 64'd0;
            last_done_index <= 32'hffffffff;
            frame_phase <= 32'd0;
            frame_snapshot_req <= 1'b0;
            snapshot_ack_seen <= 4'd0;
            read_complete_low_seen <= 4'd0;
            read_complete_seen <= 4'd0;
            active_source_mask <= 4'd0;
            publish_guard_count <= 11'd0;
            done_bitmap <= 4'd0;
            if (auto_mwr_busy || state == ST_PAYLOAD_WAIT ||
                state == ST_META_WAIT) begin
                reset_pending <= 1'b1;
                state <= ST_ABORT_WAIT;
            end
            else begin
                reset_pending <= 1'b0;
                free_bitmap <= 4'd0;
                writing_index <= 32'hffffffff;
                state <= ST_IDLE;
            end
        end
        else begin
            if (control_commit) begin
                if (configuration_valid && !crc_enable_reg) begin
                    config_ok <= 1'b1;
                    error_code <= 32'd0;
                    free_bitmap <= ring_mask;
                    done_bitmap <= 4'd0;
                    writing_index <= 32'hffffffff;
                    allocation_cursor <= 2'd3;
                end
                else begin
                    config_ok <= 1'b0;
                    error_code <= 32'h00000001;
                    irq_status <= irq_status | 32'h00000008;
                    if (irq_enable_reg && irq_mask[3])
                        irq_pulse <= 1'b1;
                end
            end

            if (control_start) begin
                if (bar_write_value[0] && config_ok && !crc_enable_reg) begin
                    running <= 1'b1;
                    stop_pending <= 1'b0;
                    frame_phase <= 32'd0;
                end
                else begin
                    running <= 1'b0;
                    error_code <= 32'h00000001;
                    irq_status <= irq_status | 32'h00000008;
                    if (bar_write_value[4] && irq_mask[3])
                        irq_pulse <= 1'b1;
                end
            end

            if (control_stop) begin
                stop_pending <= 1'b1;
            end

            if (running && frame_tick && (state != ST_IDLE)) begin
                drop_count <= drop_count + 32'd1;
                irq_status <= irq_status | 32'h00000002;
                if (irq_enable_reg && irq_mask[1])
                    irq_pulse <= 1'b1;
            end

            case (state)
                ST_IDLE: begin
                    frame_snapshot_req <= 1'b0;
                    writing_index <= 32'hffffffff;
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b0;
                    end
                    else if (running && frame_tick) begin
                        if (!source_ready_sync) begin
                            drop_count <= drop_count + 32'd1;
                            irq_status <= irq_status | 32'h00000010;
                            if (irq_enable_reg && irq_mask[4])
                                irq_pulse <= 1'b1;
                        end
                        else if (available_buffers == 4'd0) begin
                            drop_count <= drop_count + 32'd1;
                            irq_status <= irq_status | 32'h00000002;
                            if (irq_enable_reg && irq_mask[1])
                                irq_pulse <= 1'b1;
                        end
                        else begin
                            active_buffer_index <= next_buffer_index;
                            active_buffer_addr <= buffer_address(next_buffer_index);
                            active_frame_seq <= producer_seq + 64'd1;
                            active_timestamp <= timestamp_counter;
                            allocation_cursor <= next_buffer_index;
                            free_bitmap[next_buffer_index] <= 1'b0;
                            writing_index <= {30'd0, next_buffer_index};
                            payload_chunk <= 11'd0;
                            stream_row <= 12'd0;
                            stream_col <= 9'd0;
                            active_source_mask <= source_valid_sync;
                            snapshot_ack_seen <= 4'd0;
                            read_complete_low_seen <= 4'd0;
                            read_complete_seen <= 4'd0;
                            frame_snapshot_req <= 1'b1;
                            state <= ST_SNAPSHOT;
                        end
                    end
                end

                ST_SNAPSHOT: begin
                    snapshot_ack_seen <= snapshot_ack_seen |
                                         snapshot_ack_sync;
                    read_complete_low_seen <= read_complete_low_seen |
                                              ~read_complete_sync;
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b0;
                        frame_snapshot_req <= 1'b0;
                        free_bitmap[active_buffer_index] <= 1'b1;
                        writing_index <= 32'hffffffff;
                        active_source_mask <= 4'd0;
                        snapshot_ack_seen <= 4'd0;
                        read_complete_low_seen <= 4'd0;
                        read_complete_seen <= 4'd0;
                        state <= ST_IDLE;
                    end
                    else if (((snapshot_ack_seen | snapshot_ack_sync) &
                         active_source_mask) == active_source_mask) begin
                        frame_snapshot_req <= 1'b0;
                        state <= ST_WAIT_FIFO;
                    end
                end

                ST_WAIT_FIFO: begin
                    read_complete_low_seen <= read_complete_low_seen |
                                              ~read_complete_sync;
                    read_complete_seen <= read_complete_seen |
                        (read_complete_sync & read_complete_low_seen);
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b0;
                        frame_snapshot_req <= 1'b0;
                        free_bitmap[active_buffer_index] <= 1'b1;
                        writing_index <= 32'hffffffff;
                        active_source_mask <= 4'd0;
                        snapshot_ack_seen <= 4'd0;
                        read_complete_low_seen <= 4'd0;
                        read_complete_seen <= 4'd0;
                        state <= ST_IDLE;
                    end
                    else if (stream_underflow) begin
                        error_code <= 32'h00000002;
                        irq_status <= irq_status | 32'h00000004;
                        running <= 1'b0;
                        free_bitmap[active_buffer_index] <= 1'b1;
                        writing_index <= 32'hffffffff;
                        state <= ST_IDLE;
                        if (irq_enable_reg && irq_mask[2])
                            irq_pulse <= 1'b1;
                    end
                    else if (chunk_data_ready) begin
                        state <= ST_PAYLOAD_REQ;
                    end
                end

                ST_PAYLOAD_REQ: begin
                    read_complete_low_seen <= read_complete_low_seen |
                                              ~read_complete_sync;
                    read_complete_seen <= read_complete_seen |
                        (read_complete_sync & read_complete_low_seen);
                    if (stop_requested) begin
                        running <= 1'b0;
                        frame_snapshot_req <= 1'b0;
                        if (auto_mwr_req_ack) begin
                            stop_pending <= 1'b1;
                            state <= ST_PAYLOAD_WAIT;
                        end
                        else begin
                            stop_pending <= 1'b0;
                            free_bitmap[active_buffer_index] <= 1'b1;
                            writing_index <= 32'hffffffff;
                            active_source_mask <= 4'd0;
                            snapshot_ack_seen <= 4'd0;
                            read_complete_low_seen <= 4'd0;
                            read_complete_seen <= 4'd0;
                            state <= ST_IDLE;
                        end
                    end
                    else if (auto_mwr_req_ack)
                        state <= ST_PAYLOAD_WAIT;
                end

                ST_PAYLOAD_WAIT: begin
                    read_complete_low_seen <= read_complete_low_seen |
                                              ~read_complete_sync;
                    read_complete_seen <= read_complete_seen |
                        (read_complete_sync & read_complete_low_seen);
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b1;
                    end
                    if (auto_mwr_done) begin
                        if (stream_underflow || reset_pending ||
                            stop_requested) begin
                            free_bitmap[active_buffer_index] <= 1'b1;
                            writing_index <= 32'hffffffff;
                            active_source_mask <= 4'd0;
                            snapshot_ack_seen <= 4'd0;
                            read_complete_low_seen <= 4'd0;
                            read_complete_seen <= 4'd0;
                            if (stop_requested) begin
                                running <= 1'b0;
                                stop_pending <= 1'b0;
                            end
                            if (stream_underflow) begin
                                error_code <= 32'h00000002;
                                irq_status <= irq_status | 32'h00000004;
                                running <= 1'b0;
                                if (irq_enable_reg && irq_mask[2])
                                    irq_pulse <= 1'b1;
                            end
                            state <= ST_IDLE;
                        end
                        else if (payload_chunk == PAYLOAD_CHUNKS - 1) begin
                            state <= ST_META_REQ;
                        end
                        else begin
                            payload_chunk <= payload_chunk + 11'd1;
                            if (stream_col_advance >= 10'd160) begin
                                stream_col <= stream_col_advance - 10'd160;
                                stream_row <= stream_row + 12'd1;
                            end
                            else begin
                                stream_col <= stream_col_advance[8:0];
                            end
                            state <= ST_WAIT_FIFO;
                        end
                    end
                end

                ST_META_REQ: begin
                    if (stop_requested) begin
                        running <= 1'b0;
                        frame_snapshot_req <= 1'b0;
                        if (auto_mwr_req_ack) begin
                            stop_pending <= 1'b1;
                            state <= ST_META_WAIT;
                        end
                        else begin
                            stop_pending <= 1'b0;
                            free_bitmap[active_buffer_index] <= 1'b1;
                            writing_index <= 32'hffffffff;
                            active_source_mask <= 4'd0;
                            snapshot_ack_seen <= 4'd0;
                            read_complete_low_seen <= 4'd0;
                            read_complete_seen <= 4'd0;
                            state <= ST_IDLE;
                        end
                    end
                    else if (auto_mwr_req_ack)
                        state <= ST_META_WAIT;
                end

                ST_META_WAIT: begin
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b1;
                    end
                    if (auto_mwr_done) begin
                        publish_guard_count <= META_PUBLISH_GUARD;
                        state <= ST_PUBLISH_WAIT;
                    end
                end

                ST_PUBLISH_WAIT: begin
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b1;
                    end
                    if (publish_guard_count != 11'd0)
                        publish_guard_count <= publish_guard_count - 11'd1;
                    else if (!auto_mwr_busy)
                        state <= ST_COMPLETE;
                end

                ST_COMPLETE: begin
                    done_bitmap[active_buffer_index] <= 1'b1;
                    producer_seq <= active_frame_seq;
                    last_timestamp <= active_timestamp;
                    last_done_index <= {30'd0, active_buffer_index};
                    writing_index <= 32'hffffffff;
                    irq_status <= irq_status | 32'h00000001;
                    if (irq_enable_reg && irq_mask[0])
                        irq_pulse <= 1'b1;
                    if (stop_requested) begin
                        running <= 1'b0;
                        stop_pending <= 1'b0;
                    end
                    state <= ST_IDLE;
                end

                ST_ABORT_WAIT: begin
                    frame_snapshot_req <= 1'b0;
                    if (!auto_mwr_busy) begin
                        free_bitmap <= 4'd0;
                        done_bitmap <= 4'd0;
                        writing_index <= 32'hffffffff;
                        reset_pending <= 1'b0;
                        stop_pending <= 1'b0;
                        running <= 1'b0;
                        state <= ST_IDLE;
                    end
                end

                default: state <= ST_IDLE;
            endcase
        end
    end
end

function [31:0] bar_read_word;
    input [15:0] address;
    begin
        case (address)
            16'h0200: bar_read_word = V2_MAGIC;
            16'h0204: bar_read_word = V2_VERSION;
            16'h0208: bar_read_word = V2_CAPABILITIES;
            16'h020c: bar_read_word = FRAME_BYTES;
            16'h0210: bar_read_word = {26'd0, crc_enable_reg,
                                       irq_enable_reg, 3'd0, enable_reg};
            16'h0214: bar_read_word = status_value;
            16'h0218: bar_read_word = irq_status;
            16'h021c: bar_read_word = irq_mask;
            16'h0220: bar_read_word = cfg_width;
            16'h0224: bar_read_word = cfg_height;
            16'h0228: bar_read_word = cfg_stride;
            16'h022c: bar_read_word = cfg_pixel_format;
            16'h0230: bar_read_word = cfg_frame_bytes;
            16'h0234: bar_read_word = cfg_source_layout;
            16'h0238: bar_read_word = cfg_source_map;
            16'h023c: bar_read_word = cfg_ring_count;
            16'h0240: bar_read_word = cfg_meta_offset;
            16'h0244: bar_read_word = producer_seq[31:0];
            16'h0248: bar_read_word = producer_seq[63:32];
            16'h024c: bar_read_word = last_done_index;
            16'h0250: bar_read_word = drop_count;
            16'h0254: bar_read_word = error_code;
            16'h0258: bar_read_word = last_timestamp[31:0];
            16'h025c: bar_read_word = last_timestamp[63:32];
            16'h0260: bar_read_word = TIMESTAMP_HZ;
            16'h0264: bar_read_word = {28'd0, free_bitmap};
            16'h0268: bar_read_word = {28'd0, done_bitmap};
            16'h026c: bar_read_word = 32'd0;
            16'h0270: bar_read_word = writing_index;
            16'h0274: bar_read_word = TARGET_FPS_MILLI;
            16'h0278: bar_read_word = {28'd0, source_valid_sync};
            16'h027c: bar_read_word = V2_BUILD_ID;
            16'h0280: bar_read_word = buf0_addr_lo;
            16'h0284: bar_read_word = buf0_addr_hi;
            16'h0288: bar_read_word = buf0_capacity;
            16'h028c: bar_read_word = 32'd0;
            16'h0290: bar_read_word = buf1_addr_lo;
            16'h0294: bar_read_word = buf1_addr_hi;
            16'h0298: bar_read_word = buf1_capacity;
            16'h029c: bar_read_word = 32'd0;
            16'h02a0: bar_read_word = buf2_addr_lo;
            16'h02a4: bar_read_word = buf2_addr_hi;
            16'h02a8: bar_read_word = buf2_capacity;
            16'h02ac: bar_read_word = 32'd0;
            16'h02b0: bar_read_word = buf3_addr_lo;
            16'h02b4: bar_read_word = buf3_addr_hi;
            16'h02b8: bar_read_word = buf3_capacity;
            16'h02bc: bar_read_word = 32'd0;
            16'h02c0: bar_read_word = {
                running, stop_pending, auto_mwr_busy, auto_mwr_req,
                frame_snapshot_req, payload_chunk, read_complete_seen,
                snapshot_ack_seen, active_source_mask, state
            };
            16'h02c4: bar_read_word = {
                5'd0, ch1_fifo_level, 5'd0, ch0_fifo_level
            };
            16'h02c8: bar_read_word = {
                5'd0, ch3_fifo_level, 5'd0, ch2_fifo_level
            };
            16'h02cc: bar_read_word = {
                8'd0, read_complete_seen, read_complete_sync,
                snapshot_ack_seen, snapshot_ack_sync,
                source_valid_sync, active_source_mask
            };
            default: bar_read_word = 32'd0;
        endcase
    end
endfunction

// The vendor read path retains i_rd_addr[15:12], which may contain the
// system-assigned BAR base. BAR1 is 4 KiB, so decode only its byte offset.
wire [15:0] bar_read_base = {4'b0000, bar_rd_addr[7:0], 4'b0000};
wire bar_read_hit = (bar_read_base >= 16'h0200) &&
                    (bar_read_base <= 16'h02c0);
wire [127:0] bar_read_data_next = {
    bar_read_word(bar_read_base + 16'd12),
    bar_read_word(bar_read_base + 16'd8),
    bar_read_word(bar_read_base + 16'd4),
    bar_read_word(bar_read_base)
};

always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        bar_rd_override <= 1'b0;
        bar_rd_data <= 128'd0;
    end
    else if (bar_rd_clk_en) begin
        bar_rd_override <= bar_read_hit;
        bar_rd_data <= bar_read_data_next;
    end
end

// The vendor MWR reader is timed for a synchronous 128-bit RAM.  Register the
// metadata output so address zero is not skipped during the initial prefetch.
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        metadata_data <= 128'd0;
    else begin
        case (dma_data_addr[3:0])
            4'd0: metadata_data <= {
                {30'd0, active_buffer_index},
                32'h00000002,
                32'h02000100,
                V2_MAGIC
            };
            4'd1: metadata_data <= {
                active_timestamp[63:32],
                active_timestamp[31:0],
                active_frame_seq[63:32],
                active_frame_seq[31:0]
            };
            4'd2: metadata_data <= {
                cfg_pixel_format,
                cfg_stride,
                {cfg_height[15:0], cfg_width[15:0]},
                cfg_frame_bytes
            };
            4'd3: metadata_data <= {
                32'd0,
                32'd0,
                {28'd0, active_source_mask},
                cfg_source_layout
            };
            default: metadata_data <= 128'd0;
        endcase
    end
end

endmodule
