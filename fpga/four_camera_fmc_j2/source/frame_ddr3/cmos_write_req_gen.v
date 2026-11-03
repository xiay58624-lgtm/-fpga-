module cmos_write_req_gen(
	input              rst,
	input              pclk,
	input              cmos_vsync,
	output reg         write_req,
	output reg[1:0]    write_addr_index,
	output reg[1:0]    read_addr_index,
	input              write_req_ack
);
reg cmos_vsync_d0;
reg cmos_vsync_d1;
always@(posedge pclk or posedge rst)
begin
	if(rst == 1'b1)
	begin
		cmos_vsync_d0 <= 1'b0;
		cmos_vsync_d1 <= 1'b0;
	end
	else
	begin
		cmos_vsync_d0 <= cmos_vsync;
		cmos_vsync_d1 <= cmos_vsync_d0;
	end
end
always@(posedge pclk or posedge rst)
begin
	if(rst == 1'b1)
		write_req <= 1'b0;
	else if(cmos_vsync_d0 == 1'b1 && cmos_vsync_d1 == 1'b0)
		write_req <= 1'b1;
	else if(write_req_ack == 1'b1)
		write_req <= 1'b0;
end
always@(posedge pclk or posedge rst)
begin
	if(rst == 1'b1)
		write_addr_index <= 2'b0;
	else if(cmos_vsync_d0 == 1'b1 && cmos_vsync_d1 == 1'b0)
		write_addr_index <= write_addr_index + 2'd1;
end

always@(posedge pclk or posedge rst)
begin
	if(rst == 1'b1)
		read_addr_index <= 2'b0;
	else if(cmos_vsync_d0 == 1'b1 && cmos_vsync_d1 == 1'b0)
		read_addr_index <= write_addr_index;
end
endmodule

// Detects recent frame-sync activity in the PCIe control clock domain.  The
// committed-frame bit is checked separately, so one observed edge only marks
// the physical source as present; it cannot publish an incomplete frame.
module video_frame_activity_watchdog #(
	parameter integer TIMEOUT_CYCLES = 31250000
)(
	input      monitor_clk,
	input      rst_n,
	input      frame_sync_async,
	output reg source_active
);

function integer clog2;
	input integer value;
	integer i;
	begin
		value = value - 1;
		for (i = 0; value > 0; i = i + 1)
			value = value >> 1;
		clog2 = (i == 0) ? 1 : i;
	end
endfunction

localparam integer TIMEOUT_COUNT_WIDTH = clog2(TIMEOUT_CYCLES + 1);

(* ASYNC_REG = "TRUE" *) reg frame_sync_meta;
(* ASYNC_REG = "TRUE" *) reg frame_sync_sync;
reg frame_sync_d;
reg [TIMEOUT_COUNT_WIDTH-1:0] idle_count;

wire frame_sync_edge = frame_sync_sync ^ frame_sync_d;

always @(posedge monitor_clk or negedge rst_n) begin
	if (!rst_n) begin
		frame_sync_meta <= 1'b0;
		frame_sync_sync <= 1'b0;
		frame_sync_d <= 1'b0;
		idle_count <= {TIMEOUT_COUNT_WIDTH{1'b0}};
		source_active <= 1'b0;
	end
	else begin
		frame_sync_meta <= frame_sync_async;
		frame_sync_sync <= frame_sync_meta;
		frame_sync_d <= frame_sync_sync;

		if (frame_sync_edge) begin
			idle_count <= {TIMEOUT_COUNT_WIDTH{1'b0}};
			source_active <= 1'b1;
		end
		else if (source_active) begin
			if ((TIMEOUT_CYCLES <= 1) ||
		    (idle_count == TIMEOUT_CYCLES - 1)) begin
				idle_count <= {TIMEOUT_COUNT_WIDTH{1'b0}};
				source_active <= 1'b0;
			end
			else begin
				idle_count <= idle_count + 1'b1;
			end
		end
	end
end

endmodule

// Four-slot frame ownership controller.  All address ownership lives in the
// DDR clock domain; only complete frames are published to the read side.
module frame_buffer_commit_ctrl(
	input              rst,
	input              mem_clk,
	input              frame_vsync_async,
	input              read_req_async,
	input              source_active_async,
	input              read_enable,
	input              write_req_ack,
	input              write_finish,
	input              read_req_ack,
	input              read_finish,
	output reg         write_req,
	output reg [1:0]   write_addr_index,
	output reg         read_req,
	output reg [1:0]   read_addr_index,
	output reg         frame_valid,
	output reg         read_complete
);

reg frame_vsync_meta;
reg frame_vsync_sync;
reg frame_vsync_d;
reg read_req_meta;
reg read_req_sync;
reg source_active_meta;
reg source_active_sync;
reg read_enable_meta;
reg read_enable_sync;
reg read_request_armed;

reg write_finish_d;
reg read_finish_d;
reg [1:0] alloc_cursor;
reg [1:0] committed_idx;
reg       committed_valid;
reg [1:0] active_write_idx;
reg       active_write_valid;
reg [1:0] active_read_idx;
reg       active_read_valid;

wire frame_start = frame_vsync_sync && !frame_vsync_d;
wire write_finish_rise = write_finish && !write_finish_d;
wire read_finish_rise = read_finish && !read_finish_d;

function [1:0] choose_free_slot;
	input [1:0] start_idx;
	input       committed_valid;
	input [1:0] committed_slot;
	input       read_valid;
	input [1:0] read_slot;
	input       write_valid;
	input [1:0] write_slot;
	integer offset;
	reg [1:0] candidate;
	reg found;
	begin
		choose_free_slot = start_idx + 2'd1;
		found = 1'b0;
		for (offset = 1; offset <= 4; offset = offset + 1) begin
			candidate = start_idx + offset;
			if (!found &&
			    (!committed_valid || candidate != committed_slot) &&
			    (!read_valid || candidate != read_slot) &&
			    (!write_valid || candidate != write_slot)) begin
				choose_free_slot = candidate;
				found = 1'b1;
			end
		end
	end
endfunction

wire [1:0] next_write_idx = choose_free_slot(
	alloc_cursor,
	committed_valid,
	committed_idx,
	active_read_valid,
	active_read_idx,
	active_write_valid,
	active_write_idx
);

// Synchronize the source-frame boundary and the PCIe read request into ACLK.
always @(posedge mem_clk or posedge rst) begin
	if (rst) begin
		frame_vsync_meta <= 1'b0;
		frame_vsync_sync <= 1'b0;
		frame_vsync_d <= 1'b0;
		read_req_meta <= 1'b0;
		read_req_sync <= 1'b0;
		source_active_meta <= 1'b0;
		source_active_sync <= 1'b0;
		read_enable_meta <= 1'b0;
		read_enable_sync <= 1'b0;
		write_finish_d <= 1'b0;
		read_finish_d <= 1'b0;
	end
	else begin
		frame_vsync_meta <= frame_vsync_async;
		frame_vsync_sync <= frame_vsync_meta;
		frame_vsync_d <= frame_vsync_sync;
		read_req_meta <= read_req_async;
		read_req_sync <= read_req_meta;
		source_active_meta <= source_active_async;
		source_active_sync <= source_active_meta;
		read_enable_meta <= read_enable;
		read_enable_sync <= read_enable_meta;
		write_finish_d <= write_finish;
		read_finish_d <= read_finish;
	end
end

always @(posedge mem_clk or posedge rst) begin
	if (rst) begin
		write_req <= 1'b0;
		write_addr_index <= 2'd0;
		read_req <= 1'b0;
		read_addr_index <= 2'd0;
		frame_valid <= 1'b0;
		read_request_armed <= 1'b1;
		alloc_cursor <= 2'd3;
		committed_idx <= 2'd0;
		committed_valid <= 1'b0;
		active_write_idx <= 2'd0;
		active_write_valid <= 1'b0;
		active_read_idx <= 2'd0;
		active_read_valid <= 1'b0;
		read_complete <= 1'b0;
	end
	else begin
		// A low request rearms exactly one read transaction for the next pulse.
		if (!read_req_sync)
			read_request_armed <= 1'b1;

		// An offline source invalidates its old committed image.  Any active
		// PCIe read keeps its reserved slot until read_finish.
		if (!source_active_sync) begin
			write_req <= 1'b0;
			frame_valid <= 1'b0;
			active_write_valid <= 1'b0;
		end

		// A new source frame aborts any incomplete frame at the writer's next
		// burst boundary.  The pending slot remains stable through the ACK.
		if (source_active_sync && frame_start && !write_req) begin
			write_addr_index <= next_write_idx;
			alloc_cursor <= next_write_idx;
			write_req <= 1'b1;
		end

		if (write_req && write_req_ack) begin
			write_req <= 1'b0;
			active_write_idx <= write_addr_index;
			active_write_valid <= source_active_sync;
		end

		// Publishing is atomic: an address becomes readable only after the DDR
		// writer has completed the configured full-frame length.
		if (write_finish_rise && active_write_valid && source_active_sync) begin
			committed_idx <= active_write_idx;
			committed_valid <= 1'b1;
			frame_valid <= 1'b1;
			active_write_valid <= 1'b0;
		end

		// Keep the visible read index current while idle.  Once a request is
		// launched, active_read_valid freezes the slot through read_finish.
		if (!active_read_valid && !read_req && committed_valid)
			read_addr_index <= committed_idx;

		// read_enable_sync is a frame-latched mask from V2.  If a source drops
		// after that mask was captured, its last complete DDR frame remains safe
		// to read once; future masks exclude it and the compositor emits black.
		if (read_enable_sync && committed_valid && read_req_sync &&
		    read_request_armed && !active_read_valid && !read_req) begin
			read_addr_index <= committed_idx;
			active_read_idx <= committed_idx;
			active_read_valid <= 1'b1;
			read_req <= 1'b1;
			read_request_armed <= 1'b0;
			read_complete <= 1'b0;
		end

		if (read_req && read_req_ack)
			read_req <= 1'b0;

		if (read_finish_rise && active_read_valid) begin
			active_read_valid <= 1'b0;
			read_addr_index <= committed_idx;
			read_complete <= 1'b1;
		end
	end
end

endmodule
