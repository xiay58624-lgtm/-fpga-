module axi_ctrl#(
	parameter MEM_DATA_BITS      = 256  ,
    parameter DATA_WIDTH         = 256  ,
	parameter READ_DATA_BITS     = 16   ,      
	parameter WRITE_DATA_BITS    = 16   ,       
	parameter ADDR_BITS          = 27   ,      
	parameter BUSRT_BITS         = 10   ,   
	parameter BURST_SIZE         = 256  ,
    parameter FRAME_LEN          = 28'd129600 //frame size 1920*1080*16/256=129600   
)(
    // Reset, Clock
    input                           ARESETN,
    input                           ACLK,

    // Master Write Address
    output      [0:0]               M_AXI_AWID,
    output      [31:0]              M_AXI_AWADDR,
    output      [7:0]               M_AXI_AWLEN,    // Burst Length: 0-255
    output      [2:0]               M_AXI_AWSIZE,   // Burst Size: 100
    output      [1:0]               M_AXI_AWBURST,  // Burst Type: Fixed 2'b01(Incremental Burst)
    output                          M_AXI_AWLOCK,   // Lock: Fixed 2'b00
    output      [3:0]               M_AXI_AWCACHE,  // Cache: Fiex 2'b0011
    output      [2:0]               M_AXI_AWPROT,   // Protect: Fixed 2'b000
    output      [3:0]               M_AXI_AWQOS,    // QoS: Fixed 2'b0000
    output      [0:0]               M_AXI_AWUSER,   // User: Fixed 32'd0
    output                          M_AXI_AWVALID,
    input                           M_AXI_AWREADY,

    // Master Write Data
    output      [DATA_WIDTH-1:0]    M_AXI_WDATA,
    output      [DATA_WIDTH/8-1:0]  M_AXI_WSTRB,
    output                          M_AXI_WLAST,
    output      [0:0]               M_AXI_WUSER,
    output                          M_AXI_WVALID,
    input                           M_AXI_WREADY,

    // Master Write Response
    input       [0:0]               M_AXI_BID,
    input       [1:0]               M_AXI_BRESP,
    input       [0:0]               M_AXI_BUSER,
    input                           M_AXI_BVALID,
    output                          M_AXI_BREADY,
        
    // Master Read Address
    output      [0:0]               M_AXI_ARID,
    output      [31:0]              M_AXI_ARADDR,
    output      [7:0]               M_AXI_ARLEN,
    output      [2:0]               M_AXI_ARSIZE,
    output      [1:0]               M_AXI_ARBURST,
    output      [1:0]               M_AXI_ARLOCK,//
    output      [3:0]               M_AXI_ARCACHE,
    output      [2:0]               M_AXI_ARPROT,
    output      [3:0]               M_AXI_ARQOS,
    output      [0:0]               M_AXI_ARUSER,
    output                          M_AXI_ARVALID,
    input                           M_AXI_ARREADY,
        
    // Master Read Data 
    input       [0:0]               M_AXI_RID,
    input       [DATA_WIDTH-1:0]    M_AXI_RDATA,//
    input       [1:0]               M_AXI_RRESP,
    input                           M_AXI_RLAST,
    input       [0:0]               M_AXI_RUSER,
    input                           M_AXI_RVALID,
    output                          M_AXI_RREADY,

    // key
    input       [7:0]               key,
    //channel 0 write and read
    input                           ch0_wframe_pclk,
    input                           ch0_wframe_rst_n,
    input                           ch0_wframe_vsync,      //注意这里使用的场同步信号为高电平
    input                           ch0_wframe_data_valid,
    input     [32-1:0]              ch0_wframe_data,
    

    input                           ch0_rframe_pclk,
    input                           ch0_rframe_rst_n,
    input                           ch0_rframe_vsync,
    input                           ch0_rframe_req,
    output                          ch0_rframe_req_ack,
    input                           ch0_rframe_data_en,
    output    [128-1:0]             ch0_rframe_data,
    output                          ch0_rframe_data_valid,
    output                          ch0_read_line_full,

    //channel 1 write and read
    input                           ch1_wframe_pclk,
    input                           ch1_wframe_rst_n,
    input                           ch1_wframe_vsync,
    input                           ch1_wframe_data_valid,
    input     [32-1:0] ch1_wframe_data,

    input                           ch1_rframe_pclk,
    input                           ch1_rframe_rst_n,
    input                           ch1_rframe_vsync,
    input                           ch1_rframe_req,
    output                          ch1_rframe_req_ack,
    input                           ch1_rframe_data_en,
    output    [16-1:0]  ch1_rframe_data,
    output                          ch1_rframe_data_valid,
    output                          ch1_read_line_full,

    //channel 2 write and read
    input                           ch2_wframe_pclk,
    input                           ch2_wframe_rst_n,
    input                           ch2_wframe_vsync,
    input                           ch2_wframe_data_valid,
    input     [32-1:0] ch2_wframe_data,

    input                           ch2_rframe_pclk,
    input                           ch2_rframe_rst_n,
    input                           ch2_rframe_vsync,
    input                           ch2_rframe_req,
    output                          ch2_rframe_req_ack,
    input                           ch2_rframe_data_en,
    output    [16-1:0]  ch2_rframe_data,
    output                          ch2_rframe_data_valid,
    output                          ch2_read_line_full,

    //channel 3 write and read
    input                           ch3_wframe_pclk,
    input                           ch3_wframe_rst_n,
    input                           ch3_wframe_vsync,
    input                           ch3_wframe_data_valid,
    input     [32-1:0] ch3_wframe_data,

    input                           ch3_rframe_pclk,
    input                           ch3_rframe_rst_n,
    input                           ch3_rframe_vsync,
    input                           ch3_rframe_req,
    output                          ch3_rframe_req_ack,
    input                           ch3_rframe_data_en,
    output    [16-1:0]  ch3_rframe_data,
    output                          ch3_rframe_data_valid,
    output                          ch3_read_line_full     
);

//==========================================================================================
//信号定义
//==========================================================================================
//通道0
wire                            ch0_wr_burst_data_req;
wire                            ch0_wr_burst_finish;
wire                            ch0_rd_burst_finish;
wire                            ch0_rd_burst_req;
wire                            ch0_wr_burst_req;
wire[BUSRT_BITS - 1:0]          ch0_rd_burst_len;
wire[BUSRT_BITS - 1:0]          ch0_wr_burst_len;
wire[ADDR_BITS - 1:0]           ch0_rd_burst_addr;
wire[ADDR_BITS - 1:0]           ch0_wr_burst_addr;
wire                            ch0_rd_burst_data_valid;
wire[MEM_DATA_BITS - 1 : 0]     ch0_rd_burst_data;
wire[MEM_DATA_BITS - 1 : 0]     ch0_wr_burst_data;

wire                            ch0_read_req;
wire                            ch0_read_req_ack;
wire                            ch0_read_en;
wire[15:0]                      ch0_read_data;
wire                            ch0_write_en;
wire[15:0]                      ch0_write_data;
wire                            ch0_write_req;
wire                            ch0_write_req_ack;
wire[1:0]                       ch0_write_addr_index;
wire[1:0]                       ch0_read_addr_index;

//通道1
wire                            ch1_wr_burst_data_req;
wire                            ch1_wr_burst_finish;
wire                            ch1_rd_burst_finish;
wire                            ch1_rd_burst_req;
wire                            ch1_wr_burst_req;
wire[BUSRT_BITS - 1:0]          ch1_rd_burst_len;
wire[BUSRT_BITS - 1:0]          ch1_wr_burst_len;
wire[ADDR_BITS - 1:0]           ch1_rd_burst_addr;
wire[ADDR_BITS - 1:0]           ch1_wr_burst_addr;
wire                            ch1_rd_burst_data_valid;
wire[MEM_DATA_BITS - 1 : 0]     ch1_rd_burst_data;
wire[MEM_DATA_BITS - 1 : 0]     ch1_wr_burst_data;
wire                            ch1_read_req;
wire                            ch1_read_req_ack;
wire                            ch1_read_en;
wire[15:0]                      ch1_read_data;
wire                            ch1_write_en;
wire[15:0]                      ch1_write_data;
wire                            ch1_write_req;
wire                            ch1_write_req_ack;
wire[1:0]                       ch1_write_addr_index;
wire[1:0]                       ch1_read_addr_index;

//通道2
wire                            ch2_wr_burst_data_req;
wire                            ch2_wr_burst_finish;
wire                            ch2_rd_burst_finish;
wire                            ch2_rd_burst_req;
wire                            ch2_wr_burst_req;
wire[BUSRT_BITS - 1:0]          ch2_rd_burst_len;
wire[BUSRT_BITS - 1:0]          ch2_wr_burst_len;
wire[ADDR_BITS - 1:0]           ch2_rd_burst_addr;
wire[ADDR_BITS - 1:0]           ch2_wr_burst_addr;
wire                            ch2_rd_burst_data_valid;
wire[MEM_DATA_BITS - 1 : 0]     ch2_rd_burst_data;
wire[MEM_DATA_BITS - 1 : 0]     ch2_wr_burst_data;

wire                            ch2_read_req;
wire                            ch2_read_req_ack;
wire                            ch2_read_en;
wire[15:0]                      ch2_read_data;
wire                            ch2_write_en;
wire[15:0]                      ch2_write_data;
wire                            ch2_write_req;
wire                            ch2_write_req_ack;
wire[1:0]                       ch2_write_addr_index;
wire[1:0]                       ch2_read_addr_index;


//通道3
wire                            ch3_wr_burst_data_req;
wire                            ch3_wr_burst_finish;
wire                            ch3_rd_burst_finish;
wire                            ch3_rd_burst_req;
wire                            ch3_wr_burst_req;
wire[BUSRT_BITS - 1:0]          ch3_rd_burst_len;
wire[BUSRT_BITS - 1:0]          ch3_wr_burst_len;
wire[ADDR_BITS - 1:0]           ch3_rd_burst_addr;
wire[ADDR_BITS - 1:0]           ch3_wr_burst_addr;
wire                            ch3_rd_burst_data_valid;
wire[MEM_DATA_BITS - 1 : 0]     ch3_rd_burst_data;
wire[MEM_DATA_BITS - 1 : 0]     ch3_wr_burst_data;

wire                            ch3_read_req;
wire                            ch3_read_req_ack;
wire                            ch3_read_en;
wire[15:0]                      ch3_read_data;
wire                            ch3_write_en;
wire[15:0]                      ch3_write_data;
wire                            ch3_write_req;
wire                            ch3_write_req_ack;
wire[1:0]                       ch3_write_addr_index;
wire[1:0]                       ch3_read_addr_index;


//
wire                            wr_burst_data_req;
wire                            wr_burst_finish;
wire                            rd_burst_finish;
wire                            rd_burst_req;
wire                            wr_burst_req;
wire[BUSRT_BITS - 1:0]          rd_burst_len;
wire[BUSRT_BITS - 1:0]          wr_burst_len;
wire[ADDR_BITS - 1:0]           rd_burst_addr;
wire[ADDR_BITS - 1:0]           wr_burst_addr;
wire                            rd_burst_data_valid;
wire[MEM_DATA_BITS - 1 : 0]     rd_burst_data;
wire[MEM_DATA_BITS - 1 : 0]     wr_burst_data;


//==========================================================================================
//摄像头的帧开始 就开始切换地址
//==========================================================================================
//CMOS sensor writes the request and generates the read and write address index
//通道0
cmos_write_req_gen cmos_write_req_gen_m0(
	.rst                        (~ch0_wframe_rst_n        ),
	.pclk                       (ch0_wframe_pclk          ),   
	.cmos_vsync                 (ch0_wframe_vsync         ),
	.write_req                  (ch0_write_req            ),
	.write_addr_index           (ch0_write_addr_index     ),
	.read_addr_index            (ch0_read_addr_index      ),
	.write_req_ack              (ch0_write_req_ack        )
);

//通道1
cmos_write_req_gen cmos_write_req_gen_m1(
    .rst                        (~ch1_wframe_rst_n        ),
    .pclk                       (ch1_wframe_pclk          ),   
    .cmos_vsync                 (ch1_wframe_vsync         ),
    .write_req                  (ch1_write_req            ),
    .write_addr_index           (ch1_write_addr_index     ),
    .read_addr_index            (ch1_read_addr_index      ),
    .write_req_ack              (ch1_write_req_ack        )
);

//通道2
cmos_write_req_gen cmos_write_req_gen_m2(
    .rst                        (~ch2_wframe_rst_n        ),
    .pclk                       (ch2_wframe_pclk          ),   
    .cmos_vsync                 (ch2_wframe_vsync         ),
    .write_req                  (ch2_write_req            ),
    .write_addr_index           (ch2_write_addr_index     ),
    .read_addr_index            (ch2_read_addr_index      ),
    .write_req_ack              (ch2_write_req_ack        )
);

//通道3
cmos_write_req_gen cmos_write_req_gen_m3(
    .rst                        (~ch3_wframe_rst_n        ),
    .pclk                       (ch3_wframe_pclk          ),   
    .cmos_vsync                 (ch3_wframe_vsync         ),
    .write_req                  (ch3_write_req            ),
    .write_addr_index           (ch3_write_addr_index     ),
    .read_addr_index            (ch3_read_addr_index      ),
    .write_req_ack              (ch3_write_req_ack        )
);


//==========================================================================================
// frame_read_write 模块实例化
//==========================================================================================
//通道0
frame_read_write_sfp
#
(
	.MEM_DATA_BITS              (MEM_DATA_BITS             ),
	.READ_DATA_BITS             (128                       ),
	.WRITE_DATA_BITS            (32                        ),
	.ADDR_BITS                  (ADDR_BITS                 ),
	.BUSRT_BITS                 (BUSRT_BITS                ),
	.BURST_SIZE                 (BURST_SIZE                ) 
) 
frame_read_write_m0 
( 
	.rst                        (~ARESETN                  ),
	.mem_clk                    (ACLK                      ),

    .wframe_vsync               (ch0_wframe_vsync          ),
    .keys                       (key                       ),
    .channel_id                 (3'd0                      ),

	.rd_burst_req               (ch0_rd_burst_req          ),
	.rd_burst_len               (ch0_rd_burst_len          ),
	.rd_burst_addr              (ch0_rd_burst_addr         ),
	.rd_burst_data_valid        (ch0_rd_burst_data_valid   ),
	.rd_burst_data              (ch0_rd_burst_data         ),
	.rd_burst_finish            (ch0_rd_burst_finish       ),
	.read_clk                   (ch0_rframe_pclk           ),
	.read_req                   (ch0_rframe_req            ),
	.read_req_ack               (ch0_rframe_req_ack        ),  
	.read_finish                (                          ),
	.read_addr_0                (28'd0                     ), //The first frame address is 0
	.read_addr_1                (FRAME_LEN*4               ),
	.read_addr_2                (FRAME_LEN*8               ),
	.read_addr_3                (FRAME_LEN*12              ),
	.read_addr_index            (ch0_read_addr_index       ),
	.read_len                   (FRAME_LEN*4               ),//frame size   1920*1080*16/256=129600  //这里要读4k视频，所以乘4
	.read_en                    (ch0_rframe_data_en        ),
	.read_data                  (ch0_rframe_data           ),
	.read_data_valid            (ch0_rframe_data_valid     ),
    .read_line_full             (ch0_read_line_full        ),
 
	.wr_burst_req               (ch0_wr_burst_req          ),
	.wr_burst_len               (ch0_wr_burst_len          ),
	.wr_burst_addr              (ch0_wr_burst_addr         ),
	.wr_burst_data_req          (ch0_wr_burst_data_req     ),
	.wr_burst_data              (ch0_wr_burst_data         ),
	.wr_burst_finish            (ch0_wr_burst_finish       ),
	.write_clk                  (ch0_wframe_pclk           ),
	.write_req                  (ch0_write_req             ),
	.write_req_ack              (ch0_write_req_ack         ),
	.write_finish               (                          ),
	.write_addr_0               (28'd0                     ),
	.write_addr_1               (FRAME_LEN*4               ),
	.write_addr_2               (FRAME_LEN*8               ),
	.write_addr_3               (FRAME_LEN*12              ),
	.write_addr_index           (ch0_write_addr_index      ),
	.write_len                  (FRAME_LEN*2               ), //frame size  这里写入4k的一半，所以乘2
	.write_en                   (ch0_wframe_data_valid     ),
	.write_data                 (ch0_wframe_data           )
); 
 
//通道1 
frame_read_write_sfp 
#( 
    .MEM_DATA_BITS              (MEM_DATA_BITS             ),
    .READ_DATA_BITS             (16                        ),
    .WRITE_DATA_BITS            (32                        ),
    .ADDR_BITS                  (ADDR_BITS                 ),
    .BUSRT_BITS                 (BUSRT_BITS                ),
    .BURST_SIZE                 (BURST_SIZE                ) 
) 
frame_read_write_m1 
( 
    .rst                        (~ARESETN                  ),
    .mem_clk                    (ACLK                      ),

    .wframe_vsync               (ch1_wframe_vsync          ),
    .keys                       (key                       ),
    .channel_id                 (3'd1                      ),

    .rd_burst_req               (ch1_rd_burst_req          ),
    .rd_burst_len               (ch1_rd_burst_len          ),
    .rd_burst_addr              (ch1_rd_burst_addr         ),
    .rd_burst_data_valid        (ch1_rd_burst_data_valid   ),
    .rd_burst_data              (ch1_rd_burst_data         ),
    .rd_burst_finish            (ch1_rd_burst_finish       ),
    .read_clk                   (ch1_rframe_pclk           ),
    .read_req                   (ch1_rframe_req            ),
    .read_req_ack               (ch1_rframe_req_ack        ),  
    .read_finish                (                          ),
    .read_addr_0                (FRAME_LEN*1               ), //The first frame address is 0
    .read_addr_1                (FRAME_LEN*3               ),
    .read_addr_2                (FRAME_LEN*5               ),
    .read_addr_3                (FRAME_LEN*7               ),
    .read_addr_index            (ch1_read_addr_index       ),
    .read_len                   (FRAME_LEN                 ),//frame size   1920*1080*16/256=129600
    .read_en                    (ch1_rframe_data_en        ),
    .read_data                  (ch1_rframe_data           ),
    .read_data_valid            (ch1_rframe_data_valid     ),
    .read_line_full             (ch1_read_line_full        ),
 
    .wr_burst_req               (ch1_wr_burst_req          ),
    .wr_burst_len               (ch1_wr_burst_len          ),
    .wr_burst_addr              (ch1_wr_burst_addr         ),
    .wr_burst_data_req          (ch1_wr_burst_data_req     ),
    .wr_burst_data              (ch1_wr_burst_data         ),
    .wr_burst_finish            (ch1_wr_burst_finish       ),
    .write_clk                  (ch1_wframe_pclk           ),
    .write_req                  (ch1_write_req             ),
    .write_req_ack              (ch1_write_req_ack         ),
    .write_finish               (                          ),
    .write_addr_0               (FRAME_LEN*2               ), 
    .write_addr_1               (FRAME_LEN*6               ), 
    .write_addr_2               (FRAME_LEN*10              ), 
    .write_addr_3               (FRAME_LEN*14              ),
    .write_addr_index           (ch1_write_addr_index      ),
    .write_len                  (FRAME_LEN*2               ), //frame size
    .write_en                   (ch1_wframe_data_valid     ),
    .write_data                 (ch1_wframe_data           )
); 
 
//通道2 
frame_read_write_sfp 
#( 
    .MEM_DATA_BITS              (MEM_DATA_BITS             ),
    .READ_DATA_BITS             (16                        ),
    .WRITE_DATA_BITS            (32                        ),
    .ADDR_BITS                  (ADDR_BITS                 ),
    .BUSRT_BITS                 (BUSRT_BITS                ),
    .BURST_SIZE                 (BURST_SIZE                ) 
) 
frame_read_write_m2 
( 
    .rst                        (~ARESETN                  ),
    .mem_clk                    (ACLK                      ),

    .wframe_vsync               (ch2_wframe_vsync          ),
    .keys                       (key                       ),
    .channel_id                 (3'd2                      ),

    .rd_burst_req               (ch2_rd_burst_req          ),
    .rd_burst_len               (ch2_rd_burst_len          ),
    .rd_burst_addr              (ch2_rd_burst_addr         ),
    .rd_burst_data_valid        (ch2_rd_burst_data_valid   ),
    .rd_burst_data              (ch2_rd_burst_data         ),
    .rd_burst_finish            (ch2_rd_burst_finish       ),
    .read_clk                   (ch2_rframe_pclk           ),
    .read_req                   (ch2_rframe_req            ),
    .read_req_ack               (ch2_rframe_req_ack        ),  
    .read_finish                (                          ),
    .read_addr_0                (FRAME_LEN*8               ), //The first frame address is 0
    .read_addr_1                (FRAME_LEN*9               ),
    .read_addr_2                (FRAME_LEN*10              ),
    .read_addr_3                (FRAME_LEN*11              ),
    .read_addr_index            (ch2_read_addr_index       ),
    .read_len                   (FRAME_LEN                 ),//frame size   1920*1080*16/256=129600
    .read_en                    (ch2_rframe_data_en        ),
    .read_data                  (ch2_rframe_data           ),
    .read_data_valid            (ch2_rframe_data_valid     ),
    .read_line_full             (ch2_read_line_full        ),
 
    .wr_burst_req               (ch2_wr_burst_req          ),
    .wr_burst_len               (ch2_wr_burst_len          ),
    .wr_burst_addr              (ch2_wr_burst_addr         ),
    .wr_burst_data_req          (ch2_wr_burst_data_req     ),
    .wr_burst_data              (ch2_wr_burst_data         ),
    .wr_burst_finish            (ch2_wr_burst_finish       ),
    .write_clk                  (ch2_wframe_pclk           ),
    .write_req                  (ch2_write_req             ),
    .write_req_ack              (ch2_write_req_ack         ),
    .write_finish               (                          ),
    .write_addr_0               (FRAME_LEN*8               ), 
    .write_addr_1               (FRAME_LEN*9               ), 
    .write_addr_2               (FRAME_LEN*10              ),
    .write_addr_3               (FRAME_LEN*11              ),
    .write_addr_index           (ch2_write_addr_index      ),
    .write_len                  (FRAME_LEN                 ), //frame size
    .write_en                   (ch2_wframe_data_valid     ),
    .write_data                 (ch2_wframe_data           )
); 
 
//通道3 
frame_read_write_sfp 
#( 
    .MEM_DATA_BITS              (MEM_DATA_BITS             ),
    .READ_DATA_BITS             (16                        ),
    .WRITE_DATA_BITS            (32                        ),
    .ADDR_BITS                  (ADDR_BITS                 ),
    .BUSRT_BITS                 (BUSRT_BITS                ),
    .BURST_SIZE                 (BURST_SIZE                ) 
) 
frame_read_write_m3 
( 
    .rst                        (~ARESETN                  ),
    .mem_clk                    (ACLK                      ),

    .wframe_vsync               (ch3_wframe_vsync          ),
    .keys                       (key                       ),
    .channel_id                 (3'd3                      ),

    .rd_burst_req               (ch3_rd_burst_req          ),
    .rd_burst_len               (ch3_rd_burst_len          ),
    .rd_burst_addr              (ch3_rd_burst_addr         ),
    .rd_burst_data_valid        (ch3_rd_burst_data_valid   ),
    .rd_burst_data              (ch3_rd_burst_data         ),
    .rd_burst_finish            (ch3_rd_burst_finish       ),
    .read_clk                   (ch3_rframe_pclk           ),
    .read_req                   (ch3_rframe_req            ),
    .read_req_ack               (ch3_rframe_req_ack        ),  
    .read_finish                (                          ),
    .read_addr_0                (FRAME_LEN*12              ), //The first frame address is 0
    .read_addr_1                (FRAME_LEN*13              ),
    .read_addr_2                (FRAME_LEN*14              ),
    .read_addr_3                (FRAME_LEN*15              ),
    .read_addr_index            (ch3_read_addr_index       ),
    .read_len                   (FRAME_LEN                 ),//frame size   1920*1080*16/256=129600
    .read_en                    (ch3_rframe_data_en        ),
    .read_data                  (ch3_rframe_data           ),
    .read_data_valid            (ch3_rframe_data_valid     ),
    .read_line_full             (ch3_read_line_full        ),
 
    .wr_burst_req               (ch3_wr_burst_req          ),
    .wr_burst_len               (ch3_wr_burst_len          ),
    .wr_burst_addr              (ch3_wr_burst_addr         ),
    .wr_burst_data_req          (ch3_wr_burst_data_req     ),
    .wr_burst_data              (ch3_wr_burst_data         ),
    .wr_burst_finish            (ch3_wr_burst_finish       ),
    .write_clk                  (ch3_wframe_pclk           ),
    .write_req                  (ch3_write_req             ),
    .write_req_ack              (ch3_write_req_ack         ),
    .write_finish               (                          ),
    .write_addr_0               (FRAME_LEN*12              ), 
    .write_addr_1               (FRAME_LEN*13              ), 
    .write_addr_2               (FRAME_LEN*14              ),
    .write_addr_3               (FRAME_LEN*15              ),
    .write_addr_index           (ch3_write_addr_index      ),
    .write_len                  (FRAME_LEN                 ), //frame size
    .write_en                   (ch3_wframe_data_valid     ),
    .write_data                 (ch3_wframe_data           )
);

//==========================================================================================
// 通道仲裁模块
//==========================================================================================
//读仲裁
mem_read_arbi 
#(
	.MEM_DATA_BITS               (MEM_DATA_BITS             ),
	.ADDR_BITS                   (ADDR_BITS                 ),
	.BUSRT_BITS                  (BUSRT_BITS                )
)
mem_read_arbi_m0
(
	.rst_n                        (ARESETN                  ),
	.mem_clk                      (ACLK                     ),
	.ch0_rd_burst_req             (ch0_rd_burst_req         ),
	.ch0_rd_burst_len             (ch0_rd_burst_len         ),
	.ch0_rd_burst_addr            (ch0_rd_burst_addr        ),
	.ch0_rd_burst_data_valid      (ch0_rd_burst_data_valid  ),
	.ch0_rd_burst_data            (ch0_rd_burst_data        ),
	.ch0_rd_burst_finish          (ch0_rd_burst_finish      ),
	
	// .ch1_rd_burst_req             (ch1_rd_burst_req         ),
	// .ch1_rd_burst_len             (ch1_rd_burst_len         ),
	// .ch1_rd_burst_addr            (ch1_rd_burst_addr        ),
	// .ch1_rd_burst_data_valid      (ch1_rd_burst_data_valid  ),
	// .ch1_rd_burst_data            (ch1_rd_burst_data        ),
	// .ch1_rd_burst_finish          (ch1_rd_burst_finish      ),

	// .ch2_rd_burst_req             (ch2_rd_burst_req         ),
	// .ch2_rd_burst_len             (ch2_rd_burst_len         ),
	// .ch2_rd_burst_addr            (ch2_rd_burst_addr        ),
	// .ch2_rd_burst_data_valid      (ch2_rd_burst_data_valid  ),
	// .ch2_rd_burst_data            (ch2_rd_burst_data        ),
	// .ch2_rd_burst_finish          (ch2_rd_burst_finish      ),

	// .ch3_rd_burst_req             (ch3_rd_burst_req         ),
	// .ch3_rd_burst_len             (ch3_rd_burst_len         ),
	// .ch3_rd_burst_addr            (ch3_rd_burst_addr        ),
	// .ch3_rd_burst_data_valid      (ch3_rd_burst_data_valid  ),
	// .ch3_rd_burst_data            (ch3_rd_burst_data        ),
	// .ch3_rd_burst_finish          (ch3_rd_burst_finish      ),
	
	.rd_burst_req                 (rd_burst_req             ),
	.rd_burst_len                 (rd_burst_len             ),
	.rd_burst_addr                (rd_burst_addr            ),
	.rd_burst_data_valid          (rd_burst_data_valid      ),
	.rd_burst_data                (rd_burst_data            ),
	.rd_burst_finish              (rd_burst_finish          )	
);

//写仲裁
mem_write_arbi
#(
	.MEM_DATA_BITS               (MEM_DATA_BITS             ),
	.ADDR_BITS                   (ADDR_BITS                 ),
	.BUSRT_BITS                  (BUSRT_BITS                )
)
mem_write_arbi_m0(
	.rst_n                       (ARESETN                   ),
	.mem_clk                     (ACLK                      ),
	
	.ch0_wr_burst_req            (ch0_wr_burst_req          ),
	.ch0_wr_burst_len            (ch0_wr_burst_len          ),
	.ch0_wr_burst_addr           (ch0_wr_burst_addr         ),
	.ch0_wr_burst_data_req       (ch0_wr_burst_data_req     ),
	.ch0_wr_burst_data           (ch0_wr_burst_data         ),
	.ch0_wr_burst_finish         (ch0_wr_burst_finish       ),
	
	.ch1_wr_burst_req            (ch1_wr_burst_req          ),
	.ch1_wr_burst_len            (ch1_wr_burst_len          ),
	.ch1_wr_burst_addr           (ch1_wr_burst_addr         ),
	.ch1_wr_burst_data_req       (ch1_wr_burst_data_req     ),
	.ch1_wr_burst_data           (ch1_wr_burst_data         ),
	.ch1_wr_burst_finish         (ch1_wr_burst_finish       ),
	
	.ch2_wr_burst_req            (ch2_wr_burst_req          ),
	.ch2_wr_burst_len            (ch2_wr_burst_len          ),
	.ch2_wr_burst_addr           (ch2_wr_burst_addr         ),
	.ch2_wr_burst_data_req       (ch2_wr_burst_data_req     ),
	.ch2_wr_burst_data           (ch2_wr_burst_data         ),
	.ch2_wr_burst_finish         (ch2_wr_burst_finish       ),

	.ch3_wr_burst_req            (ch3_wr_burst_req          ),
	.ch3_wr_burst_len            (ch3_wr_burst_len          ),
	.ch3_wr_burst_addr           (ch3_wr_burst_addr         ),
	.ch3_wr_burst_data_req       (ch3_wr_burst_data_req     ),
	.ch3_wr_burst_data           (ch3_wr_burst_data         ),
	.ch3_wr_burst_finish         (ch3_wr_burst_finish       ),

	.wr_burst_req                 (wr_burst_req             ),
	.wr_burst_len                 (wr_burst_len             ),
	.wr_burst_addr                (wr_burst_addr            ),
	.wr_burst_data_req            (wr_burst_data_req        ),
	.wr_burst_data                (wr_burst_data            ),
	.wr_burst_finish              (wr_burst_finish          )	
);


reg         wr_burst_req_buf;
reg         rd_burst_req_buf;
reg         wr_rd_flag;     // 读写标志位 0:读 1:写;当同时读写请求时作用
reg         busy;


always @(posedge ACLK)begin
    if (!ARESETN)begin
        wr_rd_flag <= 1'b0;
    end
    else if (wr_burst_data_req == 1'b1)begin
        wr_rd_flag <= 1'b0;
    end
    else if (rd_burst_data_valid == 1'b1)begin
        wr_rd_flag <= 1'b1;
    end
    else begin
        wr_rd_flag <= wr_rd_flag;
    end
end

always @(posedge ACLK)begin
    if (!ARESETN)begin
        wr_burst_req_buf <= 1'b0;
        rd_burst_req_buf <= 1'b0;
        busy <= 1'b0;
    end
    else if (wr_burst_req == 1'b1 && rd_burst_req == 1'b1 && wr_rd_flag == 1'b0 && busy == 1'b0)begin
        wr_burst_req_buf <= 1'b0;
        rd_burst_req_buf <= 1'b1;
        busy <= 1'b1;
    end
    else if (wr_burst_req == 1'b1 && rd_burst_req == 1'b1 && wr_rd_flag == 1'b1 && busy == 1'b0)begin
        wr_burst_req_buf <= 1'b1;
        rd_burst_req_buf <= 1'b0;
        busy <= 1'b1;
    end 
    else if (wr_burst_req == 1'b1 && rd_burst_req == 1'b0 && busy == 1'b0)begin
        wr_burst_req_buf <= 1'b1;
        rd_burst_req_buf <= 1'b0;
        busy <= 1'b1;
    end
    else if (wr_burst_req == 1'b0 && rd_burst_req == 1'b1 && busy == 1'b0)begin
        wr_burst_req_buf <= 1'b0;
        rd_burst_req_buf <= 1'b1;
        busy <= 1'b1;
    end
    else if (wr_burst_finish == 1'b1 || rd_burst_finish == 1'b1) begin
        wr_burst_req_buf <= wr_burst_req;
        rd_burst_req_buf <= rd_burst_req;
        busy <= 1'b0;
    end
    else begin
        wr_burst_req_buf <= wr_burst_req_buf;
        rd_burst_req_buf <= rd_burst_req_buf;
        busy <= busy;
    end
end





aq_axi_master_256	u_aq_axi_master
(
	  .ARESETN                     (ARESETN                                   ),
	  .ACLK                        (ACLK                                      ),
	  .M_AXI_AWID                  (M_AXI_AWID                                ),
	  .M_AXI_AWADDR                (M_AXI_AWADDR                              ),
	  .M_AXI_AWLEN                 (M_AXI_AWLEN                               ),
	  .M_AXI_AWSIZE                (M_AXI_AWSIZE                              ),
	  .M_AXI_AWBURST               (M_AXI_AWBURST                             ),
	  .M_AXI_AWLOCK                (M_AXI_AWLOCK                              ),
	  .M_AXI_AWCACHE               (M_AXI_AWCACHE                             ),
	  .M_AXI_AWPROT                (M_AXI_AWPROT                              ),
	  .M_AXI_AWQOS                 (M_AXI_AWQOS                               ),
	  .M_AXI_AWUSER                (M_AXI_AWUSER                              ),
	  .M_AXI_AWVALID               (M_AXI_AWVALID                             ),
	  .M_AXI_AWREADY               (M_AXI_AWREADY                             ),
	  .M_AXI_WDATA                 (M_AXI_WDATA                               ),
	  .M_AXI_WSTRB                 (M_AXI_WSTRB                               ),
	  .M_AXI_WLAST                 (M_AXI_WLAST                               ),
	  .M_AXI_WUSER                 (M_AXI_WUSER                               ),
	  .M_AXI_WVALID                (M_AXI_WVALID                              ),
	  .M_AXI_WREADY                (M_AXI_WREADY                              ),
	  .M_AXI_BID                   (M_AXI_BID                                 ),
	  .M_AXI_BRESP                 (M_AXI_BRESP                               ),
	  .M_AXI_BUSER                 (M_AXI_BUSER                               ),
      .M_AXI_BVALID                (M_AXI_BVALID                              ),

	  .M_AXI_BREADY                (M_AXI_BREADY                              ),
	  .M_AXI_ARID                  (M_AXI_ARID                                ),
	  .M_AXI_ARADDR                (M_AXI_ARADDR                              ),
	  .M_AXI_ARLEN                 (M_AXI_ARLEN                               ),
	  .M_AXI_ARSIZE                (M_AXI_ARSIZE                              ),
	  .M_AXI_ARBURST               (M_AXI_ARBURST                             ),
	  .M_AXI_ARLOCK                (M_AXI_ARLOCK                              ),
	  .M_AXI_ARCACHE               (M_AXI_ARCACHE                             ),
	  .M_AXI_ARPROT                (M_AXI_ARPROT                              ),
	  .M_AXI_ARQOS                 (M_AXI_ARQOS                               ),
	  .M_AXI_ARUSER                (M_AXI_ARUSER                              ),
	  .M_AXI_ARVALID               (M_AXI_ARVALID                             ),
	  .M_AXI_ARREADY               (M_AXI_ARREADY                             ),
	  .M_AXI_RID                   (M_AXI_RID                                 ),
	  .M_AXI_RDATA                 (M_AXI_RDATA                               ),
	  .M_AXI_RRESP                 (M_AXI_RRESP                               ),
	  .M_AXI_RLAST                 (M_AXI_RLAST                               ),
	  .M_AXI_RUSER                 (M_AXI_RUSER                               ),
	  .M_AXI_RVALID                (M_AXI_RVALID                              ),
	  .M_AXI_RREADY                (M_AXI_RREADY                              ),
	  .MASTER_RST                  (1'b0                                      ),
	  .WR_START                    (wr_burst_req                              ),
    //   .WR_START                    (wr_burst_req_buf                          ),
	  .WR_ADRS                     ({wr_burst_addr[26:0],5'd0}                ),
	  .WR_LEN                      ({17'd0,wr_burst_len, 5'd0}                 ),
	  .WR_READY                    (                                          ),
	  .WR_FIFO_RE                  (wr_burst_data_req                         ),
	  .WR_FIFO_EMPTY               (1'b0                                      ),
	  .WR_FIFO_AEMPTY              (1'b0                                      ),
	  .WR_FIFO_DATA                (wr_burst_data                             ),
	  .WR_DONE                     (wr_burst_finish                           ),

	  .RD_START                    (rd_burst_req                              ),
    //   .RD_START                    (rd_burst_req_buf                          ),
	  .RD_ADRS                     ({rd_burst_addr[26:0],5'd0}                ),
	  .RD_LEN                      ({17'd0,rd_burst_len, 5'd0}                ),
	  .RD_READY                    (                                          ),
	  .RD_FIFO_WE                  (rd_burst_data_valid                       ),
	  .RD_FIFO_FULL                (1'b0                                      ),
	  .RD_FIFO_AFULL               (1'b0                                      ),
	  .RD_FIFO_DATA                (rd_burst_data                             ),
	  .RD_DONE                     (rd_burst_finish                           ),
	  .DEBUG                       (                                          )
);
endmodule