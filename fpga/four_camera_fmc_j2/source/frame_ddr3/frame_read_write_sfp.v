`timescale 1ns/1ps
module frame_read_write_sfp
#
(
	parameter MEM_DATA_BITS          = 64,
	parameter READ_DATA_BITS         = 128,
	parameter WRITE_DATA_BITS        = 16,
	parameter ADDR_BITS              = 25,
	parameter BUSRT_BITS             = 10,
	parameter BURST_SIZE             = 16
)               
(
	input                            rst,                  
	input                            mem_clk,                    // external memory controller user interface clock
	
	input                            wframe_vsync,			     // write frame vsync signal
	// input                            full_screen_key,            // full screen key signal
	// input                            multi_screen_key,           // multi screen key signal
	input   [7:0]                    keys,			             //按键输入
	input   [2:0]                    channel_id,               //通道标志


	output                           rd_burst_req,               // to external memory controller,send out a burst read request
	output[BUSRT_BITS - 1:0]         rd_burst_len,               // to external memory controller,data length of the burst read request, not bytes
	output[ADDR_BITS - 1:0]          rd_burst_addr,              // to external memory controller,base address of the burst read request 
	input                            rd_burst_data_valid,        // from external memory controller,read data valid 
	input[MEM_DATA_BITS - 1:0]       rd_burst_data,              // from external memory controller,read request data
	input                            rd_burst_finish,            // from external memory controller,burst read finish
	input                            read_clk,                   // data read module clock
	input                            read_req,                   // data read module read request,keep '1' until read_req_ack = '1'
	output                           read_req_ack,               // data read module read request response
	output                           read_finish,                // data read module read request finish
	input[ADDR_BITS - 1:0]           read_addr_0,                // data read module read request base address 0, used when read_addr_index = 0
	input[ADDR_BITS - 1:0]           read_addr_1,                // data read module read request base address 1, used when read_addr_index = 1
	input[ADDR_BITS - 1:0]           read_addr_2,                // data read module read request base address 1, used when read_addr_index = 2
	input[ADDR_BITS - 1:0]           read_addr_3,                // data read module read request base address 1, used when read_addr_index = 3
	input[1:0]                       read_addr_index,            // select valid base address from read_addr_0 read_addr_1 read_addr_2 read_addr_3
	input[ADDR_BITS - 1:0]           read_len,                   // data read module read request data length
	input                            read_en,                    // data read module read request for one data, read_data valid next clock
	output[READ_DATA_BITS  - 1:0]    read_data,                  // read data
	output reg                       read_data_valid,            // read data valid
	output reg                       read_line_full,             //当读fifo存满一行时，信号拉高

	output     [10:0]                read_fifo_level,
	output                           wr_burst_req,               // to external memory controller,send out a burst write request
	output[BUSRT_BITS - 1:0]         wr_burst_len,               // to external memory controller,data length of the burst write request, not bytes
	output[ADDR_BITS - 1:0]          wr_burst_addr,              // to external memory controller,base address of the burst write request 
	input                            wr_burst_data_req,          // from external memory controller,write data request ,before data 1 clock
	output[MEM_DATA_BITS - 1:0]      wr_burst_data/*synthesis PAP_MARK_DEBUG="true"*/,              // to external memory controller,write data
	input                            wr_burst_finish,            // from external memory controller,burst write finish
	input                            write_clk,                  // data write module clock
	input                            write_req,                  // data write module write request,keep '1' until read_req_ack = '1'
	output                           write_req_ack,              // data write module write request response
	output                           write_finish,               // data write module write request finish
	input[ADDR_BITS - 1:0]           write_addr_0,               // data write module write request base address 0, used when write_addr_index = 0
	input[ADDR_BITS - 1:0]           write_addr_1,               // data write module write request base address 1, used when write_addr_index = 1
	input[ADDR_BITS - 1:0]           write_addr_2,               // data write module write request base address 1, used when write_addr_index = 2
	input[ADDR_BITS - 1:0]           write_addr_3,               // data write module write request base address 1, used when write_addr_index = 3
	input[1:0]                       write_addr_index,           // select valid base address from write_addr_0 write_addr_1 write_addr_2 write_addr_3
	input[ADDR_BITS - 1:0]           write_len,                  // data write module write request data length
	input                            write_en,                   // data write module write request for one data
	input[WRITE_DATA_BITS - 1:0]     write_data                  // write data
);
wire[15:0]                           wrusedw/*synthesis PAP_MARK_DEBUG="true"*/;                    // write used words
wire[15:0]                           rfifo_rdusedw/*synthesis PAP_MARK_DEBUG="true"*/;              // read_fifo used words
wire[15:0]                           rdusedw/*synthesis PAP_MARK_DEBUG="true"*/;                    // read used words
wire                                 read_fifo_aclr;             // fifo Asynchronous clear
wire                                 write_fifo_aclr;            // fifo Asynchronous clear


//======================================================================
// write_clk 的复位同步化
//======================================================================
reg write_clk_rst_dly1;
reg write_clk_rst_dly2;
reg write_clk_rst_dly3;

always @(posedge write_clk)begin
	write_clk_rst_dly1 <= rst;
	write_clk_rst_dly2 <= write_clk_rst_dly1;
	write_clk_rst_dly3 <= write_clk_rst_dly2;
end

//======================================================================
// wframe_vsync上升沿判断
//======================================================================
reg    wframe_vsync_dly1;
reg    wframe_vsync_dly2;
reg    wframe_vsync_pos;

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		wframe_vsync_dly1 <= 1'b0;
		wframe_vsync_dly2 <= 1'b0;
	end
	else begin
		wframe_vsync_dly1 <= wframe_vsync;
		wframe_vsync_dly2 <= wframe_vsync_dly1;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		wframe_vsync_pos <= 1'b0;
	end
	else begin
		if (wframe_vsync_dly1 == 1'b1 && wframe_vsync_dly2 == 1'b0)begin
			wframe_vsync_pos <= 1'b1;
		end
		else begin
			wframe_vsync_pos <= 1'b0;
		end
	end
end

//======================================================================
// 按键信号同步化
//======================================================================
reg  [7:0] keys_dly1;
reg  [7:0] keys_dly2;

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		keys_dly1 <= 8'b11111111;
		keys_dly2 <= 8'b11111111;
	end
	else begin
		keys_dly1 <= keys;
		keys_dly2 <= keys_dly1;
	end
end
//======================================================================
// 按键状态判断
//======================================================================
parameter  TEN_MS_CNT = 24'd1485000;    //10ms计数器值
parameter  FULL_SCREEN_WRITE = 2'b01;  //全屏写入
parameter  MULTI_SCREEN_WRITE = 2'b10; //多屏写入

reg [23:0] full_screen_key_cnt;
reg [23:0] multi_screen_key_cnt;
reg [23:0] key1_cnt;
reg [23:0] key2_cnt;
reg [23:0] key3_cnt;
reg [23:0] key4_cnt;
reg [23:0] key8_cnt;

reg        key1_10ms_flag;  //按按键超过10ms，状态翻转
reg        key2_10ms_flag;
reg        key3_10ms_flag;
reg        key4_10ms_flag;
reg        key8_10ms_flag;

reg        key1_10ms_flag_buf; //在vsync下降沿对key1_10ms_flag进行暂存
reg        key2_10ms_flag_buf;
reg        key3_10ms_flag_buf;
reg        key4_10ms_flag_buf;
reg        key8_10ms_flag_buf;

// reg        full_screen_key_flag;   //当按按键超过10ms，状态翻转
// reg        multi_screen_key_flag;

// reg        full_screen_key_flag_buf;  //
// reg        multi_screen_key_flag_buf;

reg [1:0]  key_state;

// always @(posedge write_clk)begin
// 	if (write_clk_rst_dly3)begin
// 		full_screen_key_cnt <= 24'd0;
// 		full_screen_key_flag <= 1'b0;
// 	end
// 	else if (full_screen_key == 1'b0 && full_screen_key_cnt < TEN_MS_CNT)begin
// 		full_screen_key_cnt <= full_screen_key_cnt + 1'b1;
// 		full_screen_key_flag <= full_screen_key_flag;
// 	end
// 	else if (full_screen_key == 1'b0 && full_screen_key_cnt == TEN_MS_CNT)begin
// 		full_screen_key_cnt <= full_screen_key_cnt + 1'b1;
// 		full_screen_key_flag <= ~full_screen_key_flag;
// 	end
// 	else if (full_screen_key == 1'b0 && full_screen_key_cnt > TEN_MS_CNT)begin
// 		full_screen_key_cnt <= full_screen_key_cnt;
// 		full_screen_key_flag <= full_screen_key_flag;
// 	end
// 	else begin
// 		full_screen_key_cnt <= 24'd0;
// 		full_screen_key_flag <= full_screen_key_flag;
// 	end
// end

// always @(posedge write_clk)begin
//     if (write_clk_rst_dly3)begin
//         multi_screen_key_cnt <= 24'd0;
//         multi_screen_key_flag <= 1'b0;
//     end
// 	else if (multi_screen_key == 1'b0 && multi_screen_key_cnt < TEN_MS_CNT)begin
// 		multi_screen_key_cnt <= multi_screen_key_cnt + 1'b1;
// 		multi_screen_key_flag <= multi_screen_key_flag;
// 	end
// 	else if (multi_screen_key == 1'b0 && multi_screen_key_cnt == TEN_MS_CNT)begin
// 		multi_screen_key_cnt <= multi_screen_key_cnt + 1'b1;
// 		multi_screen_key_flag <= ~multi_screen_key_flag;
// 	end
// 	else if (multi_screen_key == 1'b0 && multi_screen_key_cnt > TEN_MS_CNT)begin
// 		multi_screen_key_cnt <= multi_screen_key_cnt;
// 		multi_screen_key_flag <= multi_screen_key_flag;
// 	end
// 	else begin
// 		multi_screen_key_cnt <= 24'd0;
// 		multi_screen_key_flag <= multi_screen_key_flag;
// 	end
// end

// always @(posedge write_clk)begin
// 	if (write_clk_rst_dly3)begin
// 		full_screen_key_flag_buf <= 1'b0;
// 		multi_screen_key_flag_buf <= 1'b1;
// 	end
// 	else if (wframe_vsync_pos == 1'b1)begin
// 		full_screen_key_flag_buf <= full_screen_key_flag;
// 		multi_screen_key_flag_buf <= multi_screen_key_flag;
// 	end
// 	else begin
// 		full_screen_key_flag_buf <= full_screen_key_flag_buf;
// 		multi_screen_key_flag_buf <= multi_screen_key_flag_buf;
// 	end
// end

// always @(posedge write_clk)begin
// 	if (write_clk_rst_dly3)begin
// 		key_state <= FULL_SCREEN_WRITE;
// 	end
// 	else if (wframe_vsync_pos == 1'b1 && full_screen_key_flag_buf != full_screen_key_flag)begin
// 		key_state <= FULL_SCREEN_WRITE;
// 	end
// 	else if (wframe_vsync_pos == 1'b1 && multi_screen_key_flag_buf != multi_screen_key_flag)begin
// 		key_state <= MULTI_SCREEN_WRITE;
// 	end
// 	else begin
// 		key_state <= key_state;
// 	end
// end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key1_cnt <= 24'd0;
		key1_10ms_flag <= 1'b0;
	end
	else if (keys_dly2[0] == 1'b0 && key1_cnt < TEN_MS_CNT)begin
		key1_cnt <= key1_cnt + 1'b1;
		key1_10ms_flag <= key1_10ms_flag;
	end
	else if (keys_dly2[0] == 1'b0 && key1_cnt == TEN_MS_CNT)begin
		key1_cnt <= key1_cnt + 1'b1;
		key1_10ms_flag <= ~key1_10ms_flag;
	end
	else if (keys_dly2[0] == 1'b0 && key1_cnt > TEN_MS_CNT)begin
		key1_cnt <= key1_cnt;
		key1_10ms_flag <= key1_10ms_flag;
	end
	else begin
		key1_cnt <= 24'd0;
		key1_10ms_flag <= key1_10ms_flag;
	end
end
always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key2_cnt <= 24'd0;
		key2_10ms_flag <= 1'b0;
	end
	else if (keys_dly2[1] == 1'b0 && key2_cnt < TEN_MS_CNT)begin
		key2_cnt <= key2_cnt + 1'b1;
		key2_10ms_flag <= key2_10ms_flag;
	end
	else if (keys_dly2[1] == 1'b0 && key2_cnt == TEN_MS_CNT)begin
		key2_cnt <= key2_cnt + 1'b1;
		key2_10ms_flag <= ~key2_10ms_flag;
	end
	else if (keys_dly2[1] == 1'b0 && key2_cnt > TEN_MS_CNT)begin
		key2_cnt <= key2_cnt;
		key2_10ms_flag <= key2_10ms_flag;
	end
	else begin
		key2_cnt <= 24'd0;
		key2_10ms_flag <= key2_10ms_flag;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key3_cnt <= 24'd0;
		key3_10ms_flag <= 1'b0;
	end
	else if (keys_dly2[2] == 1'b0 && key3_cnt < TEN_MS_CNT)begin
		key3_cnt <= key3_cnt + 1'b1;
		key3_10ms_flag <= key3_10ms_flag;
	end
	else if (keys_dly2[2] == 1'b0 && key3_cnt == TEN_MS_CNT)begin
		key3_cnt <= key3_cnt + 1'b1;
		key3_10ms_flag <= ~key3_10ms_flag;
	end
	else if (keys_dly2[2] == 1'b0 && key3_cnt > TEN_MS_CNT)begin
		key3_cnt <= key3_cnt;
		key3_10ms_flag <= key3_10ms_flag;
	end
	else begin
		key3_cnt <= 24'd0;
		key3_10ms_flag <= key3_10ms_flag;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key4_cnt <= 24'd0;
		key4_10ms_flag <= 1'b0;
	end
	else if (keys_dly2[3] == 1'b0 && key4_cnt < TEN_MS_CNT)begin
		key4_cnt <= key4_cnt + 1'b1;
		key4_10ms_flag <= key4_10ms_flag;
	end
	else if (keys_dly2[3] == 1'b0 && key4_cnt == TEN_MS_CNT)begin
		key4_cnt <= key4_cnt + 1'b1;
		key4_10ms_flag <= ~key4_10ms_flag;
	end
	else if (keys_dly2[3] == 1'b0 && key4_cnt > TEN_MS_CNT)begin
		key4_cnt <= key4_cnt;
		key4_10ms_flag <= key4_10ms_flag;
	end
	else begin
		key4_cnt <= 24'd0;
		key4_10ms_flag <= key4_10ms_flag;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key8_cnt <= 24'd0;
		key8_10ms_flag <= 1'b0;
	end
	else if (keys_dly2[7] == 1'b0 && key8_cnt < TEN_MS_CNT)begin
		key8_cnt <= key8_cnt + 1'b1;
		key8_10ms_flag <= key8_10ms_flag;
	end
	else if (keys_dly2[7] == 1'b0 && key8_cnt == TEN_MS_CNT)begin
		key8_cnt <= key8_cnt + 1'b1;
		key8_10ms_flag <= ~key8_10ms_flag;
	end
	else if (keys_dly2[7] == 1'b0 && key8_cnt > TEN_MS_CNT)begin
		key8_cnt <= key8_cnt;
		key8_10ms_flag <= key8_10ms_flag;
	end
	else begin
		key8_cnt <= 24'd0;
		key8_10ms_flag <= key8_10ms_flag;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key1_10ms_flag_buf <= 1'b0;
		key2_10ms_flag_buf <= 1'b0;
		key3_10ms_flag_buf <= 1'b0;
		key4_10ms_flag_buf <= 1'b0;
		key8_10ms_flag_buf <= 1'b1;  // 让复位后第一个vsync上升沿把key_state置为MULTI_SCREEN_WRITE
	end
	else if (wframe_vsync_pos == 1'b1)begin
		key1_10ms_flag_buf <= key1_10ms_flag;
		key2_10ms_flag_buf <= key2_10ms_flag;
		key3_10ms_flag_buf <= key3_10ms_flag;
		key4_10ms_flag_buf <= key4_10ms_flag;
		key8_10ms_flag_buf <= key8_10ms_flag;
	end
	else begin
		key1_10ms_flag_buf <= key1_10ms_flag_buf;
		key2_10ms_flag_buf <= key2_10ms_flag_buf;
		key3_10ms_flag_buf <= key3_10ms_flag_buf;
		key4_10ms_flag_buf <= key4_10ms_flag_buf;
		key8_10ms_flag_buf <= key8_10ms_flag_buf;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		key_state <= MULTI_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key8_10ms_flag_buf != key8_10ms_flag)begin
		key_state <= MULTI_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key1_10ms_flag_buf != key1_10ms_flag && channel_id == 3'd0)begin
		key_state <= FULL_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key2_10ms_flag_buf != key2_10ms_flag  && channel_id == 3'd1)begin
		key_state <= FULL_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key3_10ms_flag_buf != key3_10ms_flag && channel_id == 3'd2)begin
		key_state <= FULL_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key4_10ms_flag_buf != key4_10ms_flag && channel_id == 3'd3)begin
		key_state <= FULL_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key1_10ms_flag_buf != key1_10ms_flag && channel_id != 3'd0)begin
		key_state <= MULTI_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key2_10ms_flag_buf != key2_10ms_flag && channel_id != 3'd1)begin
		key_state <= MULTI_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key3_10ms_flag_buf != key3_10ms_flag && channel_id != 3'd2)begin
		key_state <= MULTI_SCREEN_WRITE;
	end
	else if (wframe_vsync_pos == 1'b1 && key4_10ms_flag_buf != key4_10ms_flag && channel_id != 3'd3)begin
		key_state <= MULTI_SCREEN_WRITE;
	end
	else begin
		key_state <= key_state;
	end
end

//======================================================================
// wframe 控制
//======================================================================
reg   							write_en_dly1;
reg [WRITE_DATA_BITS - 1:0]     write_data_dly1;
reg   							write_en_dly2;
reg [WRITE_DATA_BITS - 1:0]     write_data_dly2;

reg [11:0]                      write_xpos;
reg [11:0]                      write_ypos;

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		write_en_dly1 <= 1'b0;
		write_data_dly1 <= {WRITE_DATA_BITS{1'b0}};
	end
	else begin
		write_en_dly1 <= write_en;
		write_data_dly1 <= write_data;
	end
end



// 写入数据为32位，如果写入为16位，需要修改
always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		write_xpos <= 12'd2;
		write_ypos <= 12'd1;
	end
	else if (wframe_vsync_pos == 1'b1)begin
		write_xpos <= 12'd2;
		write_ypos <= 12'd1;
	end
	else if (write_en_dly1 == 1'b1)begin
		if (write_xpos == 12'd1920)begin
			write_xpos <= 12'd2;
		end
		else begin
			write_xpos <= write_xpos + 12'd2;
		end
		if (write_xpos == 12'd1920 && write_ypos == 12'd1080)begin
			write_ypos <= 12'd1;
		end
		else if (write_xpos == 12'd1920)begin
			write_ypos <= write_ypos + 1'b1;
		end
		else begin
			write_ypos <= write_ypos;
		end
	end
	else begin
		write_xpos <= write_xpos;
		write_ypos <= write_ypos;
	end
end

always @(posedge write_clk)begin
	if (write_clk_rst_dly3)begin
		write_en_dly2 <= 1'b0;
		write_data_dly2 <= {WRITE_DATA_BITS{1'b0}};
	end
	else if (key_state == MULTI_SCREEN_WRITE && write_en_dly1 == 1'b1 && write_xpos[1] == 1'b1 && write_ypos[0] == 1'b1)begin  //奇数坐标采样
		write_en_dly2 <= 1'b0;
		write_data_dly2 <= {write_data_dly2[31:16],write_data_dly1[15:0]};
	end
	else if (key_state == MULTI_SCREEN_WRITE && write_en_dly1 == 1'b1 && write_xpos[1] == 1'b0 && write_ypos[0] == 1'b1)begin  //奇数坐标采样
		write_en_dly2 <= 1'b1;
		write_data_dly2 <= {write_data_dly1[15:0],write_data_dly2[15:0]};
	end
	else if (key_state == FULL_SCREEN_WRITE && write_en_dly1 == 1'b1)begin  //全屏采样
		write_en_dly2 <= 1'b1;
		write_data_dly2 <= write_data_dly1;
	end
	else begin
		write_en_dly2 <= 1'b0;
		write_data_dly2 <= {WRITE_DATA_BITS{1'b0}};
	end
end
//instantiate an asynchronous FIFO 
//======================================================================
// 注意：
// write port : address width = 12, data width = 16
// read port  : address width = 8,  data width = 256
// almost full number: 4092
// almost empty number: 4
//======================================================================
generate
	if (WRITE_DATA_BITS == 16)begin: Gen_WFIFO_16i
		afifo_16i_64o_512 write_buf_16i(
			.wr_clk(write_clk),
			.wr_rst(write_fifo_aclr),
			// .wr_en(write_en_dly2),
			// .wr_data(write_data_dly2),  //若要使用到按键全屏分屏切换，则使用write_data_dly2
			.wr_en(write_en_dly1),
			.wr_data(write_data_dly1),
			.wr_full(),
			.wr_water_level(),
			.almost_full(),
			.rd_clk(mem_clk),
			.rd_rst(write_fifo_aclr),
			.rd_en(wr_burst_data_req),
			.rd_data(wr_burst_data),
			.rd_empty(),
			.rd_water_level(rdusedw[7:0]),
			.almost_empty()
			);
	end
	else if (WRITE_DATA_BITS == 32)begin: Gen_WFIFO_32i
		afifo_32i_256o write_buf_32i (
			.wr_clk(write_clk),                    // input
			.wr_rst(write_fifo_aclr),                    // input
			// .wr_en(write_en_dly2),                      // input
			// .wr_data(write_data_dly2),                  // input [31:0]
			.wr_en(write_en_dly1),                      // input
			.wr_data(write_data_dly1),                  // input [31:0]
			.wr_full(),                  // output
			.wr_water_level(),    // output [11:0]
			.almost_full(),          // output
			.rd_clk(mem_clk),                    // input
			.rd_rst(write_fifo_aclr),                    // input
			.rd_en(wr_burst_data_req),                      // input
			.rd_data(wr_burst_data),                  // output [255:0]
			.rd_empty(),                // output
			.rd_water_level(rdusedw[9:0]),    // output [8:0]
			.almost_empty()         // output
			);
	end
endgenerate

assign rdusedw[15:10] = 6'd0;

frame_fifo_write
#
(
	.MEM_DATA_BITS              (MEM_DATA_BITS            ),
	.ADDR_BITS                  (ADDR_BITS                ),
	.BUSRT_BITS                 (BUSRT_BITS               ),
	.BURST_SIZE                 (BURST_SIZE               )
) 
frame_fifo_write_m0              
(  
	.rst                        (rst                      ),
	.mem_clk                    (mem_clk                  ),
	.wr_burst_req               (wr_burst_req             ),
	.wr_burst_len               (wr_burst_len             ),
	.wr_burst_addr              (wr_burst_addr            ),
	.wr_burst_data_req          (wr_burst_data_req        ),
	.wr_burst_finish            (wr_burst_finish          ),
	.write_req                  (write_req                ),
	.write_req_ack              (write_req_ack            ),
	.write_finish               (write_finish             ),
	.write_addr_0               (write_addr_0             ),
	.write_addr_1               (write_addr_1             ),
	.write_addr_2               (write_addr_2             ),
	.write_addr_3               (write_addr_3             ),
	.write_addr_index           (write_addr_index         ),    
	.write_len                  (write_len                ),
	.fifo_aclr                  (write_fifo_aclr          ),
	.rdusedw                    (rdusedw                  ) 
	
);

//instantiate an asynchronous FIFO
//======================================================================
// 注意：
// write port : address width = 8,  data width = 256
// read port  : address width = 12, data width = 16
// almost full number: 252
// almost empty number: 4
//======================================================================
generate
	if (READ_DATA_BITS == 16)begin: Gen_RFIFO_16o
		afifo_64i_16o_128 read_buf_16o (
			.wr_clk(mem_clk),
			.wr_rst(read_fifo_aclr),
			.wr_en(rd_burst_data_valid),
			.wr_data(rd_burst_data),
			.wr_full(),
			.wr_water_level(wrusedw[8:0]),
			.almost_full(),
			.rd_clk(read_clk),
			.rd_rst(read_fifo_aclr),
			.rd_en(read_en),
			.rd_data(read_data),
			.rd_empty(),
			.rd_water_level(rfifo_rdusedw[12:0]),
			.almost_empty()
			);
	end
	else if (READ_DATA_BITS == 32)begin: Gen_RFIFO_32o
		afifo_256i_32o_256 read_buf_32o (
			.wr_clk(mem_clk),                    // input
			.wr_rst(read_fifo_aclr),                    // input
			.wr_en(rd_burst_data_valid),                      // input
			.wr_data(rd_burst_data),                  // input [255:0]
			.wr_full(),                  // output
			.wr_water_level(wrusedw[8:0]),    // output [8:0]
			.almost_full(),          // output
			.rd_clk(read_clk),                    // input
			.rd_rst(read_fifo_aclr),                    // input
			.rd_en(read_en),                      // input
			.rd_data(read_data),                  // output [31:0]
			.rd_empty(),                // output
			.rd_water_level(rfifo_rdusedw[11:0]),    // output [11:0]
			.almost_empty()         // output
			);

	end
	else if (READ_DATA_BITS == 128)begin: Gen_RFIFO_128o
		afifo_256i_128o the_instance_name (
			.wr_clk(mem_clk),                    // input
			.wr_rst(read_fifo_aclr),                    // input
			.wr_en(rd_burst_data_valid),                      // input
			.wr_data(rd_burst_data),                  // input [255:0]
			.wr_full(),                  // output
			.wr_water_level(wrusedw[9:0]),    // output [9:0]
			.almost_full(),          // output
			.rd_clk(read_clk),                    // input
			.rd_rst(read_fifo_aclr),                    // input
			.rd_en(read_en),                      // input
			.rd_data(read_data),                  // output [127:0]
			.rd_empty(),                // output
			.rd_water_level(rfifo_rdusedw[10:0]),    // output [10:0]
			.almost_empty(almost_empty)         // output
			);
	end

endgenerate

assign wrusedw[15:10] = 6'b0;
assign read_fifo_level = rfifo_rdusedw[10:0];


//======================================================================
// read_line_full:当可读FIFO存满一行时，信号拉高
//======================================================================
always @(posedge read_clk or posedge rst) begin
	if (rst == 1'b1) begin
		read_line_full <= 1'b0;
	end
	else if (rfifo_rdusedw[10:0] >= 12'd512 ) begin   // 256*2=512,这里是一次突发结束，因为pcie是128，因此乘2
		read_line_full <= 1'b1;
	end
	else begin
		read_line_full <= 1'b0;
	end
end



always @(posedge read_clk or posedge rst) begin
	if (rst == 1'b1) begin
		read_data_valid <= 1'b0;
	end
	else begin
		read_data_valid <= read_en; 
	end
end

frame_fifo_read
#
(
	.MEM_DATA_BITS              (MEM_DATA_BITS            ),
	.ADDR_BITS                  (ADDR_BITS                ),
	.BUSRT_BITS                 (BUSRT_BITS               ),
	.FIFO_DEPTH                 (128                      ),
	.BURST_SIZE                 (BURST_SIZE               )
)
frame_fifo_read_m0
(
	.rst                        (rst                      ),
	.mem_clk                    (mem_clk                  ),
	.rd_burst_req               (rd_burst_req             ),   
	.rd_burst_len               (rd_burst_len             ),  
	.rd_burst_addr              (rd_burst_addr            ),
	.rd_burst_data_valid        (rd_burst_data_valid      ),    
	.rd_burst_finish            (rd_burst_finish          ),
	.read_req                   (read_req                 ),
	.read_req_ack               (read_req_ack             ),
	.read_finish                (read_finish              ),
	.read_addr_0                (read_addr_0              ),
	.read_addr_1                (read_addr_1              ),
	.read_addr_2                (read_addr_2              ),
	.read_addr_3                (read_addr_3              ),
	.read_addr_index            (read_addr_index          ),    
	.read_len                   (read_len                 ),
	.fifo_aclr                  (read_fifo_aclr           ),
	.wrusedw                    (wrusedw                  )
);

endmodule
