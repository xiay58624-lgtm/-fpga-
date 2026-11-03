`timescale 1ns/1ps
module frame_read_write_256_burst
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
	output[10:0]                     read_fifo_level,            // read-domain FIFO occupancy

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

assign read_fifo_level = rfifo_rdusedw[10:0];
assign rfifo_rdusedw[15:11] = 5'd0;


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
// wframe 控制
//======================================================================
reg   							write_en_dly1;
reg [WRITE_DATA_BITS - 1:0]     write_data_dly1;


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




//instantiate an asynchronous FIFO 
//======================================================================
// 注意：
// write port : address width = 12, data width = 16
// read port  : address width = 9,  data width = 128
// almost full number: 4092
// almost empty number: 4
//======================================================================
generate
	if (WRITE_DATA_BITS == 16)begin: Gen_WFIFO_16i
		afifo_16i_128o_512 write_buf_16i(
			.wr_clk						(write_clk				),
			.wr_rst						(write_fifo_aclr		),
			.wr_en						(write_en_dly1			),	
			.wr_data					(write_data_dly1		),
			.wr_full					(						),
			.wr_water_level				(						),
			.almost_full				(						),
			.rd_clk						(mem_clk				),
			.rd_rst						(write_fifo_aclr		),
			.rd_en						(wr_burst_data_req		),
			.rd_data					(wr_burst_data			),
			.rd_empty					(						),
			.rd_water_level				(rdusedw[9:0]			),
			.almost_empty				(						)
			);
	end
	// else if (WRITE_DATA_BITS == 32)begin: Gen_WFIFO_32i
	// 	afifo_32i_256o write_buf_32i (
	// 		.wr_clk(write_clk),                    // input
	// 		.wr_rst(write_fifo_aclr),                    // input
	// 		// .wr_en(write_en_dly2),                      // input
	// 		// .wr_data(write_data_dly2),                  // input [31:0]
	// 		.wr_en(write_en_dly1),                      // input
	// 		.wr_data(write_data_dly1),                  // input [31:0]
	// 		.wr_full(),                  // output
	// 		.wr_water_level(),    // output [11:0]
	// 		.almost_full(),          // output
	// 		.rd_clk(mem_clk),                    // input
	// 		.rd_rst(write_fifo_aclr),                    // input
	// 		.rd_en(wr_burst_data_req),                      // input
	// 		.rd_data(wr_burst_data),                  // output [255:0]
	// 		.rd_empty(),                // output
	// 		.rd_water_level(rdusedw[9:0]),    // output [8:0]
	// 		.almost_empty()         // output
	// 		);
	// end
endgenerate

assign rdusedw[15:10] = 6'd0;

frame_fifo_write_256_burst
#
(
	.MEM_DATA_BITS              (MEM_DATA_BITS            ),
	.ADDR_BITS                  (ADDR_BITS                ),
	.BUSRT_BITS                 (BUSRT_BITS               ),
	.BURST_SIZE                 (64               		  )
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
// write port : address width = 10,  data width = 128
// read port  : address width = 10, data width = 128
// almost full number: 252
// almost empty number: 4
//======================================================================
generate
	// if (READ_DATA_BITS == 16)begin: Gen_RFIFO_16o
	// 	afifo_64i_16o_128 read_buf_16o (
	// 		.wr_clk(mem_clk),
	// 		.wr_rst(read_fifo_aclr),
	// 		.wr_en(rd_burst_data_valid),
	// 		.wr_data(rd_burst_data),
	// 		.wr_full(),
	// 		.wr_water_level(wrusedw[8:0]),
	// 		.almost_full(),
	// 		.rd_clk(read_clk),
	// 		.rd_rst(read_fifo_aclr),
	// 		.rd_en(read_en),
	// 		.rd_data(read_data),
	// 		.rd_empty(),
	// 		.rd_water_level(rfifo_rdusedw[12:0]),
	// 		.almost_empty()
	// 		);
	// end
	// else if (READ_DATA_BITS == 32)begin: Gen_RFIFO_32o
	// 	afifo_256i_32o_256 read_buf_32o (
	// 		.wr_clk(mem_clk),                    // input
	// 		.wr_rst(read_fifo_aclr),                    // input
	// 		.wr_en(rd_burst_data_valid),                      // input
	// 		.wr_data(rd_burst_data),                  // input [255:0]
	// 		.wr_full(),                  // output
	// 		.wr_water_level(wrusedw[8:0]),    // output [8:0]
	// 		.almost_full(),          // output
	// 		.rd_clk(read_clk),                    // input
	// 		.rd_rst(read_fifo_aclr),                    // input
	// 		.rd_en(read_en),                      // input
	// 		.rd_data(read_data),                  // output [31:0]
	// 		.rd_empty(),                // output
	// 		.rd_water_level(rfifo_rdusedw[11:0]),    // output [11:0]
	// 		.almost_empty()         // output
	// 		);

	// end
	if (READ_DATA_BITS == 128)begin: Gen_RFIFO_128o
		afifo_128i_128o_512 read_buf_128o (
			.wr_clk					(mem_clk					),                    // input
			.wr_rst					(read_fifo_aclr				),                    // input
			.wr_en					(rd_burst_data_valid		),                    // input
			.wr_data				(rd_burst_data				),                    // input [127:0]
			.wr_full				(							),                    // output
			.wr_water_level			(wrusedw[10:0]				),    				  // output [10:0]
			.almost_full			(							),          		  // output
			.rd_clk					(read_clk					),                    // input
			.rd_rst					(read_fifo_aclr				),                    // input
			.rd_en					(read_en					),                    // input
			.rd_data				(read_data					),                    // output [127:0]
			.rd_empty				(							),                    // output
			.rd_water_level			(rfifo_rdusedw[10:0]		),    			      // output [10:0]
			.almost_empty			(almost_empty				)         			  // output
			);
	end

endgenerate

assign wrusedw[15:11] = 5'b0;


//======================================================================
// read_line_full:当可读FIFO存满一行时，信号拉高
//======================================================================
always @(posedge read_clk or posedge rst) begin
	if (rst == 1'b1) begin
		read_line_full <= 1'b0;
	end
	else if (rfifo_rdusedw[11:0] >= 12'd160 ) begin   // 256*2=512,这里是一次突发结束，因为pcie是128，因此乘2
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

frame_fifo_read_256_burst
#
(
	.MEM_DATA_BITS              (MEM_DATA_BITS            ),
	.ADDR_BITS                  (ADDR_BITS                ),
	.BUSRT_BITS                 (BUSRT_BITS               ),
	.FIFO_DEPTH                 (128                      ),
	.BURST_SIZE                 (160              	      )
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
