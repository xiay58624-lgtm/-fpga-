`timescale 1ns / 1ps
`define UD #1

module hdmi_out_custom_75m #(
    parameter integer H_ACTIVE = 1280,
    parameter integer H_FP     = 110,
    parameter integer H_SYNC   = 40,
    parameter integer H_BP     = 220,
    parameter integer V_ACTIVE = 720,
    parameter integer V_FP     = 5,
    parameter integer V_SYNC   = 5,
    parameter integer V_BP     = 20,
    parameter integer HS_POL   = 0,
    parameter integer VS_POL   = 0,
    parameter integer IN_VS_ACTIVE_LOW = 0,
    parameter integer GENLOCK_EN = 1,
    parameter integer GENLOCK_GAIN_SHIFT = 10,
    parameter integer GENLOCK_LINE_THRESH = 1,
    parameter integer GENLOCK_CONFIRM_FRAMES = 4,
    parameter integer GENLOCK_STEP_PIXELS = 128,
    parameter integer MAX_CONCEAL_LINES = 3,
    parameter integer LINE_PIXELS = 1280,
    parameter integer STREAM_TIMEOUT_CYCLES = 200000
)(
    input  wire        pixclk,
    input  wire        rst,
    input  wire        en,

    input  wire        fifo_empty,
    input  wire [13:0] fifo_level,
    output wire        fifo_rd_en,
    input  wire [35:0] fifo_rd_data,

    output reg         vs_out,
    output reg         hs_out,
    output reg         de_out,
    output reg         stream_valid,
    output reg  [7:0]  r_out,
    output reg  [7:0]  g_out,
    output reg  [7:0]  b_out
);
    localparam integer H_TOTAL = H_ACTIVE + H_FP + H_SYNC + H_BP;
    localparam integer V_TOTAL = V_ACTIVE + V_FP + V_SYNC + V_BP;
    localparam integer H_DE_S  = H_SYNC + H_BP;
    localparam integer H_DE_E  = H_SYNC + H_BP + H_ACTIVE;
    localparam integer V_DE_S  = V_SYNC + V_BP;
    localparam integer V_DE_E  = V_SYNC + V_BP + V_ACTIVE;
    localparam integer V_BLANK_LINES = V_TOTAL - V_ACTIVE;
    localparam [31:0] WORD_V_SYNC  = 32'hFFAA55BC;
    localparam [31:0] WORD_H_START = 32'hAA0000BC;
    localparam [31:0] WORD_H_END   = 32'hCC0000BC;
    localparam [15:0] H_DATA_TAG   = 16'h5A5A;

    function integer clog2;
        input integer value;
        integer i;
        begin
            value = value - 1;
            for (i = 0; value > 0; i = i + 1)
                value = value >> 1;
            clog2 = i;
        end
    endfunction

    function [31:0] phase_err;
        input [31:0] phase_cnt;
        input [31:0] out_len_u;
        reg signed [31:0] out_len;
        reg signed [31:0] phase;
        begin
            out_len = $signed(out_len_u);
            phase   = $signed({1'b0, phase_cnt});
            if (phase > (out_len >>> 1))
                phase_err = phase - out_len;
            else
                phase_err = phase;
        end
    endfunction

    localparam integer H_CNT_WIDTH = clog2(H_TOTAL + GENLOCK_STEP_PIXELS);
    localparam integer V_CNT_WIDTH = clog2(V_TOTAL);
    localparam [H_CNT_WIDTH:0] H_TOTAL_COUNT = H_TOTAL;
    localparam [H_CNT_WIDTH:0] GENLOCK_STEP_COUNT = GENLOCK_STEP_PIXELS;
    localparam [31:0] FRAME_BODY_PIXELS = H_TOTAL * (V_TOTAL - 1);

    reg [H_CNT_WIDTH-1:0] h_cnt;
    reg [V_CNT_WIDTH-1:0] v_cnt;
    reg signed [1:0]         v_total_adj_applied;
    reg signed [1:0]         v_total_adj_next;
    wire [H_CNT_WIDTH:0]     tail_h_total;
    wire [H_CNT_WIDTH:0]     current_h_total;
    wire [31:0]              frame_total_pixels;
    wire                     line_end;
    wire                     frame_end;

    wire hs_i;
    wire vs_i;
    wire de_i;

    assign hs_i = (h_cnt < H_SYNC);
    assign vs_i = (v_cnt < V_SYNC);
    assign de_i = (h_cnt >= H_DE_S) && (h_cnt < H_DE_E) && (v_cnt >= V_DE_S) && (v_cnt < V_DE_E);

    localparam integer LINE_AW = clog2(LINE_PIXELS);
    localparam [2:0] LINE_FIFO_START = 3'd2;
    localparam [2:0] LINE_FIFO_DEPTH = 3'd4;
    localparam [17:0] STREAM_TIMEOUT = STREAM_TIMEOUT_CYCLES;

    reg        wr_de_d;
    reg        pkt_in_line;
    reg [LINE_AW:0] pkt_pixel_cnt;
    reg stream_synced;
    reg [17:0] no_packet_cnt;

    reg [15:0] skip_cnt;
    reg       skip_req;
    reg [15:0] skip_period;
    wire      do_skip;
    wire      rd_en_w;
    wire      line_queue_full;

    assign do_skip = 1'b0;
    reg       rd_fire_d;

    wire [31:0] rd_data;
    wire [3:0]  rd_word_k;
    wire        rd_de;
    wire        rd_vs;
    wire        rd_hs;
    wire [15:0] rd_rgb565;
    wire [7:0]  rd_pix_r;
    wire [7:0]  rd_pix_g;
    wire [7:0]  rd_pix_b;
    wire        is_vsync_pkt;
    wire        is_h_start_pkt;
    wire        is_h_end_pkt;
    wire        is_h_data_raw;
    wire        is_h_data_pkt;

    assign rd_data   = fifo_rd_data[31:0];
    assign rd_word_k = fifo_rd_data[35:32];
    assign is_vsync_pkt   = (rd_word_k == 4'b0001) && (rd_data == WORD_V_SYNC);
    assign is_h_start_pkt = (rd_word_k == 4'b0001) && (rd_data == WORD_H_START);
    assign is_h_end_pkt   = (rd_word_k == 4'b0001) && (rd_data == WORD_H_END);
    assign is_h_data_raw  = (rd_word_k == 4'b0000) && (rd_data[31:16] == H_DATA_TAG);
    assign is_h_data_pkt  = is_h_data_raw && pkt_in_line && (pkt_pixel_cnt < LINE_PIXELS);
    // Pause on H_END so the following cycle sees the updated line_count
    // before it can consume the next H_START from the synchronous FIFO.
    assign rd_en_w = en && !rst && !fifo_empty &&
                     (!stream_synced || pkt_in_line || !line_queue_full) &&
                     !(rd_fire_d && is_h_end_pkt);
    assign fifo_rd_en = rd_en_w;
    wire packet_line_complete = rd_fire_d && is_h_end_pkt && pkt_in_line &&
                                (pkt_pixel_cnt == LINE_PIXELS);
    assign rd_de     = is_h_data_pkt;
    assign rd_hs     = is_h_start_pkt;
    assign rd_vs     = is_vsync_pkt;
    assign rd_rgb565 = rd_data[15:0];
    assign rd_pix_r  = {rd_rgb565[15:11], rd_rgb565[15:13]};
    assign rd_pix_g  = {rd_rgb565[10:5],  rd_rgb565[10:9]};
    assign rd_pix_b  = {rd_rgb565[4:0],   rd_rgb565[4:2]};

    reg vs_d;
    reg frame_sync;
    reg frame_sync_pending;
    reg genlock_locked;
    reg output_stream_valid;
    reg [31:0] out_phase_cnt;
    reg signed [31:0] err_pix_meas;
    reg [2:0] gl_pos_cnt;
    reg [2:0] gl_neg_cnt;
    wire              apply_frame_sync;
    wire              stream_timeout;

    reg [23:0] line_mem0 [0:LINE_PIXELS-1];
    reg [23:0] line_mem1 [0:LINE_PIXELS-1];
    reg [23:0] line_mem2 [0:LINE_PIXELS-1];
    reg [23:0] line_mem3 [0:LINE_PIXELS-1];
    reg [1:0]  wr_line;
    reg [1:0]  rd_line;
    reg [1:0]  out_line;
    reg [LINE_AW-1:0] wr_x;
    reg [2:0]  line_count;
    reg        line_output_started;
    reg        output_line_valid;
    reg [1:0]  conceal_line_count;
    reg        capture_line;
    wire       in_line_end;
    wire       in_line_complete;
    wire       out_line_start;
    wire       push_line;
    wire       pop_line;
    wire [LINE_AW-1:0] out_x;
    wire [23:0] rd_line_data;
    wire       conceal_line_used = (conceal_line_count != 2'd0);

    assign in_line_end    = rd_fire_d && !rd_de && wr_de_d;
    assign in_line_complete = (pkt_pixel_cnt == LINE_PIXELS);
    // Keep the pre-roll queue intact until a complete local frame boundary
    // has made the stream visible to DDR.
    assign out_line_start = en && output_stream_valid &&
                            (h_cnt == H_DE_S - 1) &&
                            (v_cnt >= V_DE_S) && (v_cnt < V_DE_E);
    assign line_queue_full = line_output_started ?
                             (line_count >= LINE_FIFO_DEPTH - 3'd1) :
                             (line_count >= LINE_FIFO_DEPTH);
    assign push_line = in_line_end && in_line_complete && capture_line;
    assign pop_line = out_line_start &&
                      ((!line_output_started && (line_count >= LINE_FIFO_START)) ||
                       (line_output_started && (line_count != 3'd0)));
    assign out_x = de_i ?
                   (h_cnt[LINE_AW-1:0] - H_DE_S[LINE_AW-1:0]) :
                   {LINE_AW{1'b0}};
    assign rd_line_data = (out_line == 2'd0) ? line_mem0[out_x] :
                          (out_line == 2'd1) ? line_mem1[out_x] :
                          (out_line == 2'd2) ? line_mem2[out_x] :
                                               line_mem3[out_x];
    // The shared SFP transports complete-line bursts, so its VS arrival phase
    // naturally contains line-scale arbitration jitter. Changing V_TOTAL by a
    // complete line turns that jitter into a visible frame jump. Keep every
    // active and ordinary blanking line at H_TOTAL and make the small clock
    // correction only at the end of the final front-porch line.
    assign tail_h_total = (v_total_adj_applied > 0) ?
                          (H_TOTAL_COUNT + GENLOCK_STEP_COUNT) :
                          (v_total_adj_applied < 0) ?
                          (H_TOTAL_COUNT - GENLOCK_STEP_COUNT) :
                          H_TOTAL_COUNT;
    assign current_h_total = (v_cnt == V_TOTAL - 1) ?
                             tail_h_total : H_TOTAL_COUNT;
    assign frame_total_pixels = FRAME_BODY_PIXELS + tail_h_total;
    assign line_end = (h_cnt == current_h_total - 1'b1);
    assign frame_end = line_end && (v_cnt == V_TOTAL - 1);
    // Before the first visible raster there is no frame to tear, so align at
    // the next line boundary. Waiting for the next vertical blank can fill the
    // four-line queue and stall the RX FIFO for almost one frame. Once output
    // is visible, retain the vertical-blank-only realignment rule.
    assign apply_frame_sync = frame_sync_pending && line_end &&
                               (!output_stream_valid || (v_cnt < V_DE_S));
    assign stream_timeout = (no_packet_cnt == STREAM_TIMEOUT);

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            h_cnt <= {H_CNT_WIDTH{1'b0}};
            v_cnt <= {V_CNT_WIDTH{1'b0}};
        end else if (!en) begin
            h_cnt <= {H_CNT_WIDTH{1'b0}};
            v_cnt <= {V_CNT_WIDTH{1'b0}};
        end else if (apply_frame_sync) begin
            h_cnt <= {H_CNT_WIDTH{1'b0}};
            v_cnt <= {V_CNT_WIDTH{1'b0}};
        end else begin
            if (line_end) begin
                h_cnt <= {H_CNT_WIDTH{1'b0}};
                if (v_cnt == V_TOTAL - 1)
                    v_cnt <= {V_CNT_WIDTH{1'b0}};
                else
                    v_cnt <= v_cnt + 1'b1;
            end else begin
                h_cnt <= h_cnt + 1'b1;
            end
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            skip_cnt <= 16'd0;
            skip_req <= 1'b0;
        end else if (!en) begin
            skip_cnt <= 16'd0;
            skip_req <= 1'b0;
        end else begin
            if (skip_period != 16'd0) begin
                if (skip_cnt == skip_period - 1) begin
                    skip_cnt <= 16'd0;
                    skip_req <= 1'b1;
                end else begin
                    skip_cnt <= skip_cnt + 1'b1;
                end
            end else begin
                skip_cnt <= 16'd0;
                skip_req <= 1'b0;
            end
            if (do_skip)
                skip_req <= 1'b0;
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            rd_fire_d <= 1'b0;
        end else begin
            rd_fire_d <= fifo_rd_en && !fifo_empty;
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            pkt_in_line   <= 1'b0;
            pkt_pixel_cnt <= {(LINE_AW+1){1'b0}};
        end else if (!en) begin
            pkt_in_line   <= 1'b0;
            pkt_pixel_cnt <= {(LINE_AW+1){1'b0}};
        end else if (!stream_synced) begin
            pkt_in_line   <= 1'b0;
            pkt_pixel_cnt <= {(LINE_AW+1){1'b0}};
        end else if (rd_fire_d) begin
            if (is_vsync_pkt) begin
                pkt_in_line   <= 1'b0;
                pkt_pixel_cnt <= {(LINE_AW+1){1'b0}};
            end else if (is_h_start_pkt) begin
                pkt_in_line   <= 1'b1;
                pkt_pixel_cnt <= {(LINE_AW+1){1'b0}};
            end else if (is_h_end_pkt) begin
                pkt_in_line   <= 1'b0;
                pkt_pixel_cnt <= {(LINE_AW+1){1'b0}};
            end else if (is_h_data_pkt) begin
                pkt_pixel_cnt <= pkt_pixel_cnt + 1'b1;
            end
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            no_packet_cnt <= 18'd0;
        end else if (!en) begin
            no_packet_cnt <= 18'd0;
        end else if (rd_fire_d || !fifo_empty) begin
            // A non-empty FIFO is transport activity even when this module is
            // deliberately applying backpressure because its line queue is
            // full. Only an actually empty RX FIFO may age into a timeout.
            no_packet_cnt <= 18'd0;
        end else if (no_packet_cnt != STREAM_TIMEOUT) begin
            no_packet_cnt <= no_packet_cnt + 1'b1;
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            vs_d       <= 1'b0;
            frame_sync <= 1'b0;
            frame_sync_pending <= 1'b0;
            genlock_locked <= 1'b0;
            stream_synced <= 1'b0;
            stream_valid <= 1'b0;
            err_pix_meas <= 32'sd0;
            gl_pos_cnt <= 3'd0;
            gl_neg_cnt <= 3'd0;
        end else if (!en) begin
            vs_d       <= 1'b0;
            frame_sync <= 1'b0;
            frame_sync_pending <= 1'b0;
            genlock_locked <= 1'b0;
            stream_synced <= 1'b0;
            stream_valid <= 1'b0;
            err_pix_meas <= 32'sd0;
            gl_pos_cnt <= 3'd0;
            gl_neg_cnt <= 3'd0;
        end else if (stream_timeout) begin
            vs_d       <= 1'b0;
            frame_sync <= 1'b0;
            frame_sync_pending <= 1'b0;
            genlock_locked <= 1'b0;
            stream_synced <= 1'b0;
            stream_valid <= 1'b0;
            err_pix_meas <= 32'sd0;
            gl_pos_cnt <= 3'd0;
            gl_neg_cnt <= 3'd0;
        end else begin
            if (IN_VS_ACTIVE_LOW != 0)
                frame_sync <= rd_fire_d && !rd_vs && vs_d;
            else
                frame_sync <= rd_fire_d && rd_vs && !vs_d;

            if (rd_fire_d && is_vsync_pkt)
                stream_synced <= 1'b1;

            // Transport presence is established by one structurally complete
            // active line. DDR still publishes only a fully written output
            // frame, so a single damaged SFP line cannot permanently black
            // the channel while incomplete DDR frames remain hidden.
            if (packet_line_complete)
                stream_valid <= 1'b1;

            if (frame_sync) begin
                if ((GENLOCK_EN != 0) && !genlock_locked)
                    frame_sync_pending <= 1'b1;
                else
                    frame_sync_pending <= 1'b0;

                err_pix_meas <= $signed(phase_err(out_phase_cnt, frame_total_pixels));

                if (err_pix_meas > $signed(H_TOTAL * GENLOCK_LINE_THRESH)) begin
                    if (gl_pos_cnt != 3'b111) gl_pos_cnt <= gl_pos_cnt + 3'd1;
                    gl_neg_cnt <= 3'd0;
                end else if (err_pix_meas < -$signed(H_TOTAL * GENLOCK_LINE_THRESH)) begin
                    if (gl_neg_cnt != 3'b111) gl_neg_cnt <= gl_neg_cnt + 3'd1;
                    gl_pos_cnt <= 3'd0;
                end else begin
                    gl_pos_cnt <= 3'd0;
                    gl_neg_cnt <= 3'd0;
                end
            end else if (apply_frame_sync) begin
                frame_sync_pending <= 1'b0;
                genlock_locked <= 1'b1;
            end

            if (rd_fire_d) begin
                vs_d <= rd_vs;
            end
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            out_phase_cnt <= 32'd0;
        end else if (!en) begin
            out_phase_cnt <= 32'd0;
        end else if (apply_frame_sync) begin
            out_phase_cnt <= 32'd0;
        end else if ((h_cnt == {H_CNT_WIDTH{1'b0}}) &&
                     (v_cnt == {V_CNT_WIDTH{1'b0}})) begin
            out_phase_cnt <= 32'd0;
        end else begin
            out_phase_cnt <= out_phase_cnt + 1'b1;
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            v_total_adj_applied <= 2'sd0;
            v_total_adj_next    <= 2'sd0;
        end else if (!en) begin
            v_total_adj_applied <= 2'sd0;
            v_total_adj_next    <= 2'sd0;
        end else begin
            if ((GENLOCK_EN != 0) && frame_sync) begin
                if (gl_pos_cnt >= GENLOCK_CONFIRM_FRAMES[2:0])
                    v_total_adj_next <= 2'sd1;
                else if (gl_neg_cnt >= GENLOCK_CONFIRM_FRAMES[2:0])
                    v_total_adj_next <= -2'sd1;
                else
                    v_total_adj_next <= 2'sd0;
            end

            if (apply_frame_sync || frame_end) begin
                v_total_adj_applied <= v_total_adj_next;
            end
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            skip_period <= 16'd0;
        end else if (!en) begin
            skip_period <= 16'd0;
        end else begin
            if (fifo_level < 14'd1024)
                skip_period <= 16'd256;
            else if (fifo_level < 14'd2048)
                skip_period <= 16'd512;
            else if (fifo_level < 14'd3072)
                skip_period <= 16'd1024;
            else
                skip_period <= 16'd0;
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            wr_line <= 2'd0;
            rd_line <= 2'd0;
            out_line <= 2'd0;
            wr_x <= {LINE_AW{1'b0}};
            wr_de_d <= 1'b0;
            line_count <= 3'd0;
            line_output_started <= 1'b0;
            output_line_valid <= 1'b0;
            conceal_line_count <= 2'd0;
            capture_line <= 1'b0;
        end else if (!en) begin
            wr_line <= 2'd0;
            rd_line <= 2'd0;
            out_line <= 2'd0;
            wr_x <= {LINE_AW{1'b0}};
            wr_de_d <= 1'b0;
            line_count <= 3'd0;
            line_output_started <= 1'b0;
            output_line_valid <= 1'b0;
            conceal_line_count <= 2'd0;
            capture_line <= 1'b0;
        end else if (!stream_synced) begin
            wr_line <= 2'd0;
            rd_line <= 2'd0;
            out_line <= 2'd0;
            wr_x <= {LINE_AW{1'b0}};
            wr_de_d <= 1'b0;
            line_count <= 3'd0;
            line_output_started <= 1'b0;
            output_line_valid <= 1'b0;
            conceal_line_count <= 2'd0;
            capture_line <= 1'b0;
        end else begin
            if (rd_fire_d)
                wr_de_d <= rd_de;

            if (rd_fire_d && is_h_start_pkt) begin
                wr_x <= {LINE_AW{1'b0}};
                capture_line <= !line_queue_full;
            end

            if (rd_fire_d && rd_de && capture_line) begin
                case (wr_line)
                    2'd0: line_mem0[wr_x] <= {rd_pix_r, rd_pix_g, rd_pix_b};
                    2'd1: line_mem1[wr_x] <= {rd_pix_r, rd_pix_g, rd_pix_b};
                    2'd2: line_mem2[wr_x] <= {rd_pix_r, rd_pix_g, rd_pix_b};
                    default: line_mem3[wr_x] <= {rd_pix_r, rd_pix_g, rd_pix_b};
                endcase

                if (wr_x != LINE_PIXELS - 1)
                    wr_x <= wr_x + 1'b1;
            end

            if (in_line_end) begin
                wr_x <= {LINE_AW{1'b0}};
                capture_line <= 1'b0;
            end

            if (push_line)
                wr_line <= wr_line + 2'd1;

            // Keep lines captured after the SFP frame marker while the local
            // raster moves to its safe alignment point. Clearing this queue
            // loses the top rows and later repeats stale rows at the bottom.
            if (apply_frame_sync) begin
                line_output_started <= 1'b0;
                output_line_valid <= 1'b0;
                conceal_line_count <= 2'd0;
            end else if (out_line_start) begin
                if (pop_line) begin
                    out_line <= rd_line;
                    rd_line <= rd_line + 2'd1;
                    line_output_started <= 1'b1;
                    output_line_valid <= 1'b1;
                    conceal_line_count <= 2'd0;
                end else if (line_output_started &&
                             (conceal_line_count < MAX_CONCEAL_LINES)) begin
                    // Hide a short arbitration/clock-tolerance gap by holding
                    // the last complete row. The transport timeout still
                    // invalidates a disconnected stream, so stale video cannot
                    // be published indefinitely.
                    output_line_valid <= 1'b1;
                    conceal_line_count <= conceal_line_count + 1'b1;
                end else begin
                    output_line_valid <= 1'b0;
                end
            end

            case ({push_line, pop_line})
                2'b10: line_count <= line_count + 3'd1;
                2'b01: line_count <= line_count - 3'd1;
                default: line_count <= line_count;
            endcase
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            output_stream_valid <= 1'b0;
        end else if (!en || !stream_valid) begin
            output_stream_valid <= 1'b0;
        end else if (apply_frame_sync || frame_end) begin
            // Do not expose a raster until two complete source rows are
            // queued. This blocks startup/no-signal black frames while still
            // giving the line retimer enough pre-roll for a complete frame.
            output_stream_valid <= (line_count >= LINE_FIFO_START);
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            vs_out <= 1'b0;
            hs_out <= 1'b0;
            de_out <= 1'b0;
            r_out  <= 8'd0;
            g_out  <= 8'd0;
            b_out  <= 8'd0;
        end else if (!en || !output_stream_valid) begin
            vs_out <= 1'b0;
            hs_out <= 1'b0;
            de_out <= 1'b0;
            r_out  <= 8'd0;
            g_out  <= 8'd0;
            b_out  <= 8'd0;
        end else begin
            vs_out <= (VS_POL != 0) ? vs_i : ~vs_i;
            hs_out <= (HS_POL != 0) ? hs_i : ~hs_i;
            // Once admitted, a DDR frame must contain exactly 1280x720
            // pixels. Suppressing DE for one transiently missing row leaves
            // every write short and prevents the atomic frame from ever
            // being published. No-signal and timeout cases are already
            // blocked by output_stream_valid; only an isolated missing row
            // inside an active frame is filled here.
            de_out <= de_i;
            if (de_i) begin
                r_out <= output_line_valid ? rd_line_data[23:16] : 8'd0;
                g_out <= output_line_valid ? rd_line_data[15:8] : 8'd0;
                b_out <= output_line_valid ? rd_line_data[7:0] : 8'd0;
            end else begin
                r_out <= 8'd0;
                g_out <= 8'd0;
                b_out <= 8'd0;
            end
        end
    end
endmodule
