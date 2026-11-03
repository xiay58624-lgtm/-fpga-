`timescale 1ns / 1ps

`define UD #1
// F_GPIO feeds source 0/1 (CMOS1/2); the two cameras on FMC J2 feed
// source 2/3 (CMOS3/4). All four sources remain independent through DDR3
// and the PCIe 2x2 tile composer.
// The host receives a 1280x720 RGB565 mosaic with four 640x360 tiles.
module image_pcie_capture #(

   parameter MEM_ROW_WIDTH        = 15         ,

   parameter MEM_COLUMN_WIDTH     = 10         ,

   parameter MEM_BANK_WIDTH       = 3          ,

  parameter MEM_DQ_WIDTH          = 16         ,

  parameter MEM_DQS_WIDTH         = 2

)(
    input                                free_clk                  ,
    input                                board_rst_n               ,

    //DDR3 interface
    output                               mem_cs_n                  ,  
    output                               mem_rst_n                 ,
    output                               mem_ck                    ,
    output                               mem_ck_n                  ,
    output                               mem_cke                   ,
    output                               mem_ras_n                 ,
    output                               mem_cas_n                 ,
    output                               mem_we_n                  ,
    output                               mem_odt                   ,
    output      [MEM_ROW_WIDTH-1:0]      mem_a                     ,
    output      [MEM_BANK_WIDTH-1:0]     mem_ba                    ,
    inout       [MEM_DQ_WIDTH/8-1:0]     mem_dqs                   ,
    inout       [MEM_DQ_WIDTH/8-1:0]     mem_dqs_n                 ,
    inout       [MEM_DQ_WIDTH-1:0]       mem_dq                    ,
    output      [MEM_DQ_WIDTH/8-1:0]     mem_dm                    ,

    // PCIe interface
    input					             ref_clk_p                 ,		    // 输入参考时钟 
	input					             ref_clk_n                 ,		    // 
    // KEY1 on FPGA ball M16, active low. This pin is a user key on the
    // board, so PCIe PERST is held released inside the design. Board reset
    // remains on KEY0 / board_rst_n.
    input                                key1_n                    ,
	input		[1:0]		             rxn                       ,			//pcie接收
	input		[1:0]		             rxp                       ,			//
	output wire	[1:0]		             txn                       ,			//pcie发送
	output wire	[1:0]		             txp                       ,			// 

    //LED signals
    // output reg                           heart_beat_led            ,
    // output reg                           pclk_led                  ,
	// output reg                           ref_led                   ,

//OV5647
    // Diagnostic outputs: report FMC camera initialization on the two
    // existing status pins (bit 0 = J2/CAM2, bit 1 = J3/CAM1).
    output  [1:0]                        cmos_init_done             ,
    //coms1	        
    inout                                cmos1_scl                  ,//cmos1 i2c 
    inout                                cmos1_sda                  ,//cmos1 i2c 
    input                                cmos1_vsync                ,//cmos1 vsync
    input                                cmos1_href                 ,//cmos1 hsync refrence,data valid
    input                                cmos1_pclk                 ,//cmos1 pxiel clock
    input   [7:0]                        cmos1_data                 ,//cmos1 data
    output                               cmos1_reset                ,//cmos1 reset
    //coms2     
    inout                                cmos2_scl                  ,//cmos2 i2c 
    inout                                cmos2_sda                  ,//cmos2 i2c 
    input                                cmos2_vsync                ,//cmos2 vsync
    input                                cmos2_href                 ,//cmos2 hsync refrence,data valid
    input                                cmos2_pclk                 ,//cmos2 pxiel clock
    input   [7:0]                        cmos2_data                 ,//cmos2 data
    output                               cmos2_reset                ,//cmos2 reset
    //cmos3
    inout                                cmos3_scl                  ,//cmos3 i2c 
    inout                                cmos3_sda                  ,//cmos3 i2c 
    input                                cmos3_vsync                ,//cmos3 vsync
    input                                cmos3_href                 ,//cmos3 hsync refrence,data valid
    input                                cmos3_pclk                 ,//cmos3 pxiel clock
    input   [7:0]                        cmos3_data                 ,//cmos3 data
    output                               cmos3_reset                ,//cmos3 reset
    //cmos4
    inout                                cmos4_scl                  ,//cmos4 i2c
    inout                                cmos4_sda                  ,//cmos4 i2c
    input                                cmos4_vsync                ,//cmos4 vsync
    input                                cmos4_href                 ,//cmos4 data enable
    input                                cmos4_pclk                 ,//cmos4 pixel clock
    input   [7:0]                        cmos4_data                 ,//cmos4 data
    output                               cmos4_reset                ,//cmos4 reset
    //SFP status
    output                               sfp_link_up                ,
    output                               sfp_vsync_locked           ,
    //SFP Control
    output                               sfp_tx_disable             ,
    output                               sfp_scl                    ,
    inout                                sfp_sda                     
);

parameter CTRL_ADDR_WIDTH = MEM_ROW_WIDTH + MEM_BANK_WIDTH + MEM_COLUMN_WIDTH;
parameter TH_1S = 27'd33000000;
parameter REM_DQS_WIDTH = 9 - MEM_DQS_WIDTH;


reg                         heart_beat_led             ;
reg                         pclk_led                   ;
reg                         ref_led                    ;

wire                        ddrphy_cpd_lock            ;
wire                        ddr_init_done              ;
wire                        pll_lock                   ;
wire                        core_clk                   ;
wire [CTRL_ADDR_WIDTH-1:0]  axi_awaddr                 ;
wire                        axi_awuser_ap              ;
wire [3:0]                  axi_awuser_id              ;
wire [3:0]                  axi_awlen                  ;
wire                        axi_awready                ;
wire                        axi_awvalid                ;
wire [MEM_DQ_WIDTH*8-1:0]   axi_wdata                  ;
wire [MEM_DQ_WIDTH*8/8-1:0] axi_wstrb                  ;
wire                        axi_wready                 ;
wire [3:0]                  axi_wusero_id              ;
wire                        axi_wusero_last            ;
wire [CTRL_ADDR_WIDTH-1:0]  axi_araddr                 ;
wire                        axi_aruser_ap              ;
wire [3:0]                  axi_aruser_id              ;
wire [3:0]                  axi_arlen                  ;
wire                        axi_arready                ;
wire                        axi_arvalid                ;
wire [MEM_DQ_WIDTH*8-1:0]   axi_rdata  /* synthesis syn_keep = 1 */;
wire                        axi_rvalid /* synthesis syn_keep = 1 */;
wire [3:0]                  axi_rid                    ;
wire                        axi_rlast                  ;
wire                        resetn                     ;
reg  [26:0]                 cnt                        ;
wire [7:0]                  err_cnt                    ;
wire                        free_clk_g                 ;

//cmos
reg  [15:0]                 rstn_1ms                   ;
wire                        cmos_scl                   ;//cmos i2c clock
wire                        cmos_sda                   ;//cmos i2c data
wire                        cmos_vsync                 ;//cmos vsync
wire                        cmos_href                  ;//cmos hsync refrence,data valid
wire                        cmos_pclk                  ;//cmos pxiel clock
wire   [7:0]                cmos_data                  ;//cmos data
wire                        cmos_reset                 ;//cmos reset
wire                        initial_en                 ;
wire                        initial_en_1               ;
wire                        cmos1_init_done            ;
wire                        cmos2_init_done            ;
wire                        cmos3_init_done             ;
wire                        cmos4_init_done             ;

// Keep the existing status pins as camera initialization indicators.  Frame
// activity is diagnosed separately so a missing video signal does not mask a
// successful sensor initialization.
// LED4 (M17) shows camera-3 init until grayscale is on, then it blinks.
// LED3 (J16) stays on camera-4 init.
assign cmos_init_done[1] = cmos4_init_done;
wire[15:0]                  cmos1_d_16bit              /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos1_href_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
reg [7:0]                   cmos1_d_d0                 /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos1_href_d0              /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos1_vsync_d0             /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos1_pclk_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
wire[15:0]                  cmos2_d_16bit              /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos2_href_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
reg [7:0]                   cmos2_d_d0                 /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos2_href_d0              /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos2_vsync_d0             /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos2_pclk_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
wire[15:0]                  cmos3_d_16bit              /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos3_href_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
reg [7:0]                   cmos3_d_d0                 /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos3_href_d0              /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos3_vsync_d0             /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos3_pclk_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
wire[15:0]                  cmos4_d_16bit              /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos4_href_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;
reg [7:0]                   cmos4_d_d0                 /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos4_href_d0              /*synthesis PAP_MARK_DEBUG="1"*/;
reg                         cmos4_vsync_d0             /*synthesis PAP_MARK_DEBUG="1"*/;
wire                        cmos4_pclk_16bit           /*synthesis PAP_MARK_DEBUG="1"*/;

wire[15:0]                  o_rgb565                   ;
wire                        pclk_in_test               ;    
wire                        vs_in_test                 ;
wire                        de_in_test                 ;
wire[15:0]                  i_rgb565                   ;
wire[15:0]                  cmos1_rgb565_raw           ;
wire                        pclk_in_test_2             ;    
wire                        vs_in_test_2               ;
wire                        de_in_test_2               ;
wire[15:0]                  i_rgb565_2                 ;
wire[15:0]                  cmos2_rgb565_raw           ;
wire                        pclk_in_test_3             ;    
wire                        vs_in_test_3               ;
wire                        de_in_test_3               ;
wire[15:0]                  i_rgb565_3                 ;
wire                        pclk_in_test_4             ;    
wire                        vs_in_test_4               ;
wire                        de_in_test_4               ;
wire[15:0]                  i_rgb565_4                 ;

//pll
wire                        lock                       ;
wire                        clk_10m                    ;
wire                        clk_25m                    ;
wire                        clk_50m                    ;
wire                        clk_75m                    ;




//pcie 相关信号定义
localparam DEVICE_TYPE = 3'b000;			// @IPC enum 3'b000, 3'b001, 3'b100
localparam AXIS_SLAVE_NUM = 3;				// @IPC enum 1 2 3

//reg             ref_led;

// Test unit mode signals
wire			pcie_cfg_ctrl_en;			
wire			axis_master_tready_cfg;		

wire			cfg_axis_slave0_tvalid;		
wire	[127:0]	cfg_axis_slave0_tdata;		
wire			cfg_axis_slave0_tlast;		
wire			cfg_axis_slave0_tuser;		

// For mux
wire			axis_master_tready_mem;		
wire			axis_master_tvalid_mem;		
wire	[127:0]	axis_master_tdata_mem;		
wire	[3:0]	axis_master_tkeep_mem;		
											
wire			axis_master_tlast_mem;		
wire	[7:0]	axis_master_tuser_mem;		

wire			cross_4kb_boundary;			

wire			dma_axis_slave0_tvalid;		
wire	[127:0]	dma_axis_slave0_tdata;		
wire			dma_axis_slave0_tlast;		
wire			dma_axis_slave0_tuser;		

// Reset debounce and sync
wire			sync_button_rst_n; 			
wire			ref_core_rst_n;	
wire            sync_perst_n;
// KEY1 is not the PCIe sideband reset. Hold PERST released so the key can
// be used without disturbing the link. button_rst_n still follows KEY0.
wire            perst_n = 1'b1;
wire			s_pclk_rstn;				

// Internal signal
wire			pclk_div2/*synthesis PAP_MARK_DEBUG="1"*/;  	// 用户时钟，x2 5gt/s时，为125MHZ 2.5gt/s时为62.5
wire			pclk/*synthesis PAP_MARK_DEBUG="1"*/;			// 用户时钟，x2 5gt/s时，为125MHZ 2.5gt/s时为62.5			
wire			ref_clk; 					
wire			core_rst_n;					

wire			axis_master_tvalid;
wire			axis_master_tready;
wire	[127:0]	axis_master_tdata;
wire	[3:0]	axis_master_tkeep;
wire			axis_master_tlast;
wire	[7:0]	axis_master_tuser;

// AXI4-Stream slave 0 interface
wire			axis_slave0_tready;
wire			axis_slave0_tvalid;
wire	[127:0]	axis_slave0_tdata;
wire			axis_slave0_tlast;
wire			axis_slave0_tuser;
// AXI4-Stream slave 1 interface
wire			axis_slave1_tready;
wire			axis_slave1_tvalid;
wire	[127:0]	axis_slave1_tdata;
wire			axis_slave1_tlast;
wire			axis_slave1_tuser;
// AXI4-Stream slave 2 interface
wire			axis_slave2_tready;
wire			axis_slave2_tvalid;
wire	[127:0]	axis_slave2_tdata;
wire			axis_slave2_tlast;
wire			axis_slave2_tuser;

wire	[7:0]	cfg_pbus_num;			
wire	[4:0]	cfg_pbus_dev_num; 		
wire	[2:0]	cfg_max_rd_req_size;	
wire	[2:0]	cfg_max_payload_size;	
wire			cfg_rcb;				

wire			cfg_ido_req_en;			
wire			cfg_ido_cpl_en;			
wire	[7:0]	xadm_ph_cdts;			
wire	[11:0]	xadm_pd_cdts;			
wire	[7:0]	xadm_nph_cdts;			
wire	[11:0]	xadm_npd_cdts;			
wire	[7:0]	xadm_cplh_cdts;			
wire	[11:0]	xadm_cpld_cdts;			

wire	[4:0]	smlh_ltssm_state/*synthesis PAP_MARK_DEBUG="1"*/;//link状态机
// SFP internal signals
wire [31:0] sfp_rx_data;
wire [3:0]  sfp_rx_datak;
wire        sfp_rx_valid;
wire        sfp_rx_clk;
wire        sfp3_fifo_empty;
wire [35:0] sfp3_fifo_rd_data;
wire        sfp3_fifo_rd_en;
wire [13:0] sfp3_fifo_rd_level;
wire [7:0]  sfp3_r, sfp3_g, sfp3_b;
wire        sfp3_vs_raw, sfp3_de_raw;
wire        sfp3_stream_valid;
wire [15:0] sfp3_rgb565_raw;
reg         sfp3_video_en;
reg  [9:0]  sfp3_start_delay;
wire        sfp4_fifo_empty;
wire [35:0] sfp4_fifo_rd_data;
wire        sfp4_fifo_rd_en;
wire [13:0] sfp4_fifo_rd_level;
wire [7:0]  sfp4_r, sfp4_g, sfp4_b;
wire        sfp4_vs_raw, sfp4_de_raw;
wire        sfp4_stream_valid;
wire [15:0] sfp4_rgb565_raw;
reg         sfp4_video_en;

// Led lights up signal
reg		[22:0]	ref_led_cnt;		
reg		[26:0]	pclk_led_cnt;		
wire			smlh_link_up; 	
wire			rdlh_link_up/*synthesis PAP_MARK_DEBUG="1"*/; 	

// Uart to APB 32bits
wire			uart_p_sel;			
wire	[3:0]	uart_p_strb;		
wire	[15:0]	uart_p_addr;		
wire	[31:0]	uart_p_wdata;		
wire			uart_p_ce;			
wire			uart_p_we;			
wire			uart_p_rdy;			
wire	[31:0]	uart_p_rdata;		

// APB signal
wire	[3:0]	p_strb; 			
wire	[15:0]	p_addr; 			
wire	[31:0]	p_wdata; 			
wire			p_ce; 				
wire			p_we; 				

// APB MUX signal
// 0~5: HSSTLP 6: Reserved 7: PCIe
// 8: config
// 9: DMA
wire			p_sel_pcie;			
wire			p_sel_cfg;			
wire			p_sel_dma;			

wire	[31:0]	p_rdata_pcie;		
wire	[31:0]	p_rdata_cfg;		
wire	[31:0]	p_rdata_dma;		

wire			p_rdy_pcie;			
wire			p_rdy_cfg;			
wire			p_rdy_dma;			

assign cfg_ido_req_en	=	1'b0;	
assign cfg_ido_cpl_en	=	1'b0;	
assign xadm_ph_cdts		=	8'b0;	
assign xadm_pd_cdts		=	12'b0;	
assign xadm_nph_cdts	=	8'b0;	
assign xadm_npd_cdts	=	12'b0;	
assign xadm_cplh_cdts	=	8'b0;	
assign xadm_cpld_cdts	=	12'b0;	





//axi
wire          ch0_wframe_data_valid      ;
wire [15:0]   ch0_wframe_data            ;
wire          ch0_rframe_req;
wire          ch0_rframe_req_ack;
wire          ch0_rframe_data_en;
wire          ch0_rframe_fifo_read_en;
wire  [127:0] ch0_rframe_data;
wire          ch0_rframe_data_valid;
wire  [10:0]  ch0_read_fifo_level;
wire          ch0_read_complete;

wire          ch1_wframe_data_valid      ;
wire [15:0]   ch1_wframe_data            ;
wire          ch1_rframe_req;
wire          ch1_rframe_req_ack;
wire          ch1_rframe_data_en;
wire          ch1_rframe_fifo_read_en;
wire  [127:0] ch1_rframe_data;
wire          ch1_rframe_data_valid;
wire  [10:0]  ch1_read_fifo_level;
wire          ch1_read_complete;

wire          ch2_wframe_data_valid      ;
wire [15:0]   ch2_wframe_data            ;
wire          ch2_rframe_req;
wire          ch2_rframe_req_ack;
wire          ch2_rframe_data_en;
wire          ch2_rframe_fifo_read_en;
wire  [127:0] ch2_rframe_data;
wire          ch2_rframe_data_valid;
wire  [10:0]  ch2_read_fifo_level;
wire          ch2_read_complete;

wire          ch3_wframe_data_valid      ;
wire [15:0]   ch3_wframe_data            ;
wire          ch3_rframe_req;
wire          ch3_rframe_req_ack;
wire          ch3_rframe_data_en;
wire          ch3_rframe_fifo_read_en;
wire  [127:0] ch3_rframe_data;
wire          ch3_rframe_data_valid;
wire  [10:0]  ch3_read_fifo_level;
wire          ch3_read_complete;

wire          ddr_all_frame_valid;
wire [3:0]    ddr_frame_valid_bitmap;
// Qualify frame readiness and snapshots against the four connected cameras.
wire          ddr_camera_frame_valid;
wire [3:0]    ddr_read_source_mask;
wire [3:0]    source_live_mask;
wire [3:0]    source_valid_mask;
reg  [3:0]    source_valid_sync1;
reg  [3:0]    source_valid_sync2;
wire [3:0]    v2_frame_source_mask;
wire [3:0]    v2_snapshot_drain_mask;
wire [3:0]    pcie_frame_source_mask;
wire          cmos1_frame_active;
wire          cmos2_frame_active;
wire          cmos3_frame_active;
wire          cmos4_frame_active;
reg           v1_frame_snapshot_req;
reg  [3:0]    v1_snapshot_source_mask;
wire          v2_frame_snapshot_req;
wire          frame_snapshot_req;
reg           frame_snapshot_req_d;
wire          frame_snapshot_start;

//dma
// DMA CTRL      BASE ADDR = 0x8000
wire            o_dma_write_data_req;
wire [11:0]     o_dma_write_addr ;
wire [127:0]    i_dma_write_data;
wire [127:0]    pcie_image_dma_data;
wire [127:0]    v2_metadata_data;
wire            v2_metadata_mode;
wire            image_dma_data_req;
wire            pcie_stream_underflow;
wire            v2_active;
wire            v2_irq_pulse;
wire            v2_auto_mwr_req;
wire [9:0]      v2_auto_mwr_length;
wire [31:0]     v2_auto_mwr_addr;
wire            v2_auto_mwr_req_ack;
wire            v2_auto_mwr_done;
wire            pcie_mwr_busy;
wire            dma_bar1_wr_en;
wire [11:0]     dma_bar1_wr_addr;
wire [127:0]    dma_bar1_wr_data;
wire [15:0]     dma_bar1_wr_byte_en;
wire            dma_bar_rd_clk_en;
wire [11:0]     dma_bar_rd_addr;
wire            v2_bar_rd_override;
wire [127:0]    v2_bar_rd_data;
reg             msi_req_reg;
reg             msi_pending;
wire            msi_grant;
wire            msi_enabled;

localparam integer PCIE_TILE_WIDTH       = 640;
localparam integer PCIE_TILE_HEIGHT      = 360;
localparam integer PCIE_PIXEL_BITS       = 16;
localparam integer PCIE_DMA_BEAT_BITS    = 128;
localparam integer SOURCE_ACTIVITY_TIMEOUT_CYCLES = 31250000;
localparam integer PCIE_TILE_FRAME_BEATS =
    (PCIE_TILE_WIDTH * PCIE_TILE_HEIGHT * PCIE_PIXEL_BITS) / PCIE_DMA_BEAT_BITS;
localparam integer PCIE_FRAME_WIDTH      = PCIE_TILE_WIDTH * 2;
localparam integer PCIE_FRAME_HEIGHT     = PCIE_TILE_HEIGHT * 2;
localparam integer PCIE_LINE_BYTES       =
    PCIE_FRAME_WIDTH * (PCIE_PIXEL_BITS / 8);
localparam integer PCIE_LINE_BEATS       = PCIE_LINE_BYTES / (PCIE_DMA_BEAT_BITS / 8);
// Source bits 0/1 are F_GPIO CMOS1/2; bits 2/3 are the two FMC J2 cameras
// on CMOS3/4. No source is duplicated in this four-camera variant.
localparam [3:0] CAMERA_SOURCE_MASK     = 4'b1111;

wire            cmos2_pclk_bufg;

reg             cmos1_vsync_d1;
reg             cmos1_vsync_d2;
reg             cmos1_href_d1;
reg             cmos1_href_d2;
reg   [7:0]     cmos1_data_d1;
reg   [7:0]     cmos1_data_d2;

reg             cmos2_vsync_d1;
reg             cmos2_vsync_d2;
reg             cmos2_href_d1;
reg             cmos2_href_d2;
reg   [7:0]     cmos2_data_d1;
reg   [7:0]     cmos2_data_d2;

reg             cmos3_vsync_d1;
reg             cmos3_vsync_d2;
reg             cmos3_href_d1;
reg             cmos3_href_d2;
reg   [7:0]     cmos3_data_d1;
reg   [7:0]     cmos3_data_d2;

reg             cmos4_vsync_d1;
reg             cmos4_vsync_d2;
reg             cmos4_href_d1;
reg             cmos4_href_d2;
reg   [7:0]     cmos4_data_d1;
reg   [7:0]     cmos4_data_d2;


wire            line_full_flag_1;
wire            line_full_flag_2;
wire            line_full_flag_3;
wire            line_full_flag_4;

always @(posedge cmos1_pclk)begin
    cmos1_vsync_d1 <= cmos1_vsync;
    cmos1_vsync_d2 <= cmos1_vsync_d1;
    cmos1_href_d1 <= cmos1_href;
    cmos1_href_d2  <= cmos1_href_d1;
    cmos1_data_d1 <= cmos1_data;
    cmos1_data_d2 <= cmos1_data_d1;
end

always @(posedge cmos2_pclk)begin
    cmos2_vsync_d1 <= cmos2_vsync;
    cmos2_vsync_d2 <= cmos2_vsync_d1;
    cmos2_href_d1 <= cmos2_href;
    cmos2_href_d2  <= cmos2_href_d1;
    cmos2_data_d1 <= cmos2_data;
    cmos2_data_d2 <= cmos2_data_d1;
end

always @(posedge cmos3_pclk)begin
    cmos3_vsync_d1 <= cmos3_vsync;
    cmos3_vsync_d2 <= cmos3_vsync_d1;
    cmos3_href_d1 <= cmos3_href;
    cmos3_href_d2  <= cmos3_href_d1;
    cmos3_data_d1 <= cmos3_data;
    cmos3_data_d2 <= cmos3_data_d1;
end

always @(posedge cmos4_pclk)begin
    cmos4_vsync_d1 <= cmos4_vsync;
    cmos4_vsync_d2 <= cmos4_vsync_d1;
    cmos4_href_d1 <= cmos4_href;
    cmos4_href_d2 <= cmos4_href_d1;
    cmos4_data_d1 <= cmos4_data;
    cmos4_data_d2 <= cmos4_data_d1;
end
//*==============================================================================
//PLL
//*==============================================================================
pll pll_inst (
  .clkout0(clk_10m),    // output
  .clkout1(clk_25m),    // output
  .clkout2(clk_50m),    // output
  .clkout3(clk_75m),    // output
  .lock(lock),          // output
  .clkin1(free_clk)       // input
);
wire pixclk_74p25m;
wire pixclk_74p25m_lock;

vpll vpll_inst(
    .clkout0(pixclk_74p25m),
    .lock(pixclk_74p25m_lock),          // output
    .clkin1(free_clk)  
);
// GTP_CLKBUFR U_CLKBUFR ( 
// .CLKOUT     (cmos2_pclk_bufg), 
// .CLKIN      (cmos2_pclk)
// ); 

//*==============================================================================
//配置cmos
//*==============================================================================
//OV5640 register configure enable    
power_on_delay	power_on_delay_inst(
    .clk_50M                 (clk_50m        ),//input
    .reset_n                 (ddr_init_done  ),//input	
    .camera1_rstn            (cmos1_reset    ),//output
    .camera2_rstn            (cmos2_reset    ),//output	
    .camera_pwnd             (               ),//output
    .initial_en              (initial_en     ) //output		
);

power_on_delay_j2	power_on_delay_1_inst(
    .clk_50M                 (clk_50m        ),//input
    .reset_n                 (ddr_init_done  ),//input	
    .camera1_rstn            (cmos4_reset    ),//output
    .camera2_rstn            (cmos3_reset    ),//output	
    .camera_pwnd             (               ),//output
    .initial_en              (initial_en_1   ) //output		
);

//CMOS1 Camera 
reg_config	coms1_reg_config(
    .clk_25M                 (clk_50m            ),//input
    .camera_rstn             (cmos1_reset        ),//input
    .initial_en              (initial_en         ),//input		
    .i2c_sclk                (cmos1_scl          ),//output
    .i2c_sdat                (cmos1_sda          ),//inout
    .reg_conf_done           (cmos1_init_done    ),//output config_finished
    .reg_index               (                   ),//output reg [8:0]
    .clock_20k               (                   ) //output reg
);

//CMOS2 Camera 
reg_config	coms2_reg_config(
    .clk_25M                 (clk_50m            ),//input
    .camera_rstn             (cmos2_reset        ),//input
    .initial_en              (initial_en         ),//input		
    .i2c_sclk                (cmos2_scl          ),//output
    .i2c_sdat                (cmos2_sda          ),//inout
    .reg_conf_done           (cmos2_init_done    ),//output config_finished
    .reg_index               (                   ),//output reg [8:0]
    .clock_20k               (                   ) //output reg
);

//CMOS3 Camera 
reg_config_j2	coms3_reg_config(
    .clk_25M                 (clk_50m            ),//input
    .camera_rstn             (cmos3_reset        ),//input
    .initial_en              (initial_en_1       ),//input		
    .i2c_sclk                (cmos3_scl          ),//output
    .i2c_sdat                (cmos3_sda          ),//inout
    .reg_conf_done           (cmos3_init_done     ),//output config_finished
    .reg_index               (                   ),//output reg [8:0]
    .clock_20k               (                   ) //output reg
);

// CMOS4 Camera
reg_config_j2 coms4_reg_config(
    .clk_25M                 (clk_50m            ),
    .camera_rstn             (cmos4_reset        ),
    .initial_en              (initial_en_1       ),
    .i2c_sclk                (cmos4_scl          ),
    .i2c_sdat                (cmos4_sda          ),
    .reg_conf_done           (cmos4_init_done     ),
    .reg_index               (                   ),
    .clock_20k               (                   )
);
//===============================================================================
// SFP Receiving Modules
//===============================================================================
wire sfp_base_rst;
wire sfp_rx_parser_rst;
wire sfp3_rx_path_rst;
wire sfp4_rx_path_rst;
wire sfp3_rst;
wire sfp4_rst;
wire sfp3_path_rst_n;
wire sfp4_path_rst_n;
wire sfp3_link_ready;
wire sfp4_link_ready;
wire sfp3_rx_packet_activity;
wire sfp4_rx_packet_activity;
localparam [9:0] SFP3_START_DELAY = 10'd824;
// HDMI inputs are already source-processed. v8.1 keeps both channels in the
// conservative DETECT_SAFE path: no unconditional spatial blur, at most 25%
// tone-curve mixing, and no detail enhancement unless explicitly enabled.
assign sfp_base_rst  = ~core_rst_n | ~pixclk_74p25m_lock | ~ddr_init_done;
assign sfp3_path_rst_n = ~sfp3_rst;
assign sfp4_path_rst_n = ~sfp4_rst;

sfp_link_recovery_ctrl #(
    .LINK_STABLE_CYCLES       (4096),
    .RX_ACTIVITY_TIMEOUT_CYCLES(1000000),
    .RX_RESET_HOLD_CYCLES     (8)
) u_sfp3_link_recovery_ctrl (
    .rx_clk      (pclk_div2),
    .pixclk      (pixclk_74p25m),
    .base_rst    (sfp_base_rst),
    .rx_valid    (sfp_rx_valid),
    .rx_activity (sfp3_rx_packet_activity),
    .phy_path_rst(sfp_rx_parser_rst),
    .rx_path_rst (sfp3_rx_path_rst),
    .pix_path_rst(sfp3_rst),
    .link_ready  (sfp3_link_ready)
);

sfp_link_recovery_ctrl #(
    .LINK_STABLE_CYCLES       (4096),
    .RX_ACTIVITY_TIMEOUT_CYCLES(1000000),
    .RX_RESET_HOLD_CYCLES     (8)
) u_sfp4_link_recovery_ctrl (
    .rx_clk      (pclk_div2),
    .pixclk      (pixclk_74p25m),
    .base_rst    (sfp_base_rst),
    .rx_valid    (sfp_rx_valid),
    .rx_activity (sfp4_rx_packet_activity),
    .phy_path_rst(),
    .rx_path_rst (sfp4_rx_path_rst),
    .pix_path_rst(sfp4_rst),
    .link_ready  (sfp4_link_ready)
);

always @(posedge pixclk_74p25m or posedge sfp4_rst) begin
    if (sfp4_rst) begin
        sfp4_video_en <= 1'b0;
    end else if (!sfp4_link_ready) begin
        sfp4_video_en <= 1'b0;
    end else if (sfp4_fifo_rd_level >= 14'd4096) begin
        sfp4_video_en <= 1'b1;
    end
end

always @(posedge pixclk_74p25m or posedge sfp3_rst) begin
    if (sfp3_rst) begin
        sfp3_video_en    <= 1'b0;
        sfp3_start_delay <= 10'd0;
    end else if (!sfp3_link_ready) begin
        sfp3_video_en    <= 1'b0;
        sfp3_start_delay <= 10'd0;
    end else if (!sfp3_video_en) begin
        if (sfp3_fifo_rd_level < 14'd4096) begin
            sfp3_start_delay <= 10'd0;
        end else if (sfp3_start_delay == SFP3_START_DELAY) begin
            sfp3_video_en <= 1'b1;
        end else begin
            sfp3_start_delay <= sfp3_start_delay + 1'b1;
        end
    end
end

sfp_dual_rx_mod u_sfp_dual_rx_mod (
    // sfp_rx_data/sfp_rx_datak are registered by the PCIe soft PHY on
    // pclk_div2. Sampling them with the recovered clock made restart phase
    // dependent, so parsing and FIFO writes use their actual source clock.
    .hsst_clk      (pclk_div2        ),
    .parser_rst    (sfp_rx_parser_rst),
    .fifo3_wr_rst  (sfp3_rx_path_rst ),
    .fifo3_rd_rst  (sfp3_rst         ),
    .fifo4_wr_rst  (sfp4_rx_path_rst ),
    .fifo4_rd_rst  (sfp4_rst         ),
    .rxd           (sfp_rx_data      ),
    .rxk           (sfp_rx_datak     ),
    .pixclk        (pixclk_74p25m    ),
    .fifo3_rd_en   (sfp3_fifo_rd_en  ),
    .fifo3_empty   (sfp3_fifo_empty  ),
    .fifo3_rd_data (sfp3_fifo_rd_data),
    .fifo3_rd_level(sfp3_fifo_rd_level),
    .fifo4_rd_en   (sfp4_fifo_rd_en  ),
    .fifo4_empty   (sfp4_fifo_empty  ),
    .fifo4_rd_data (sfp4_fifo_rd_data),
    .fifo4_rd_level(sfp4_fifo_rd_level),
    .rx3_packet_activity(sfp3_rx_packet_activity),
    .rx4_packet_activity(sfp4_rx_packet_activity)
);

hdmi_out_custom_75m u_sfp3_video_retimer(
    .pixclk       (pixclk_74p25m     ),
    .rst          (sfp3_rst          ),
    .en           (sfp3_video_en     ),
    .fifo_empty   (sfp3_fifo_empty   ),
    .fifo_level   (sfp3_fifo_rd_level),
    .fifo_rd_en   (sfp3_fifo_rd_en   ),
    .fifo_rd_data (sfp3_fifo_rd_data ),
    .vs_out       (sfp3_vs_raw       ),
    .hs_out       (                  ),
    .de_out       (sfp3_de_raw       ),
    .stream_valid (sfp3_stream_valid ),
    .r_out        (sfp3_r            ),
    .g_out        (sfp3_g            ),
    .b_out        (sfp3_b            )
);

hdmi_out_custom_75m u_sfp4_video_retimer(
    .pixclk       (pixclk_74p25m     ),
    .rst          (sfp4_rst          ),
    .en           (sfp4_video_en     ),
    .fifo_empty   (sfp4_fifo_empty   ),
    .fifo_level   (sfp4_fifo_rd_level),
    .fifo_rd_en   (sfp4_fifo_rd_en   ),
    .fifo_rd_data (sfp4_fifo_rd_data ),
    .vs_out       (sfp4_vs_raw       ),
    .hs_out       (                  ),
    .de_out       (sfp4_de_raw       ),
    .stream_valid (sfp4_stream_valid ),
    .r_out        (sfp4_r            ),
    .g_out        (sfp4_g            ),
    .b_out        (sfp4_b            )
);

assign sfp3_rgb565_raw = {sfp3_r[7:3], sfp3_g[7:2], sfp3_b[7:3]};
assign sfp4_rgb565_raw = {sfp4_r[7:3], sfp4_g[7:2], sfp4_b[7:3]};

reg [23:0] sfp_vs_cnt;
reg        sfp_vs_locked_reg;
always @(posedge pixclk_74p25m or posedge sfp4_rst) begin
    if (sfp4_rst) begin
        sfp_vs_cnt <= 24'd0;
    end else if (sfp4_vs_raw) begin
        sfp_vs_cnt <= 24'd0;
    end else if (sfp_vs_cnt < 24'hFFFFFF) begin
        sfp_vs_cnt <= sfp_vs_cnt + 1'b1;
    end
end

always @(posedge pixclk_74p25m or posedge sfp4_rst) begin
    if (sfp4_rst) begin
        sfp_vs_locked_reg <= 1'b0;
    end else if (sfp_vs_cnt < 24'd7_425_000) begin
        sfp_vs_locked_reg <= 1'b1;
    end else begin
        sfp_vs_locked_reg <= 1'b0;
    end
end

assign sfp_link_up      = sfp3_link_ready | sfp4_link_ready;
assign sfp_vsync_locked = sfp_vs_locked_reg;
assign sfp_tx_disable   = 1'b0;
assign sfp_scl          = 1'b1;
assign sfp_sda          = 1'bz;

//===============================================================================
//CMOS 8bit转16bit
//===============================================================================
//CMOS1
always@(posedge cmos1_pclk)
    begin
        cmos1_d_d0        <= cmos1_data_d2    ;
        cmos1_href_d0     <= cmos1_href_d2    ;
        cmos1_vsync_d0    <= cmos1_vsync_d2   ;
    end

cmos_8_16bit cmos1_8_16bit(
.pclk           (cmos1_pclk       ),//input
.rst_n          (cmos1_init_done),//input
.pdata_i        (cmos1_d_d0       ),//input[7:0]
.de_i           (cmos1_href_d0    ),//input
.vs_i           (cmos1_vsync_d0    ),//input

.pixel_clk      (cmos1_pclk_16bit ),//output
.pdata_o        (cmos1_d_16bit    ),//output[15:0]
.de_o           (cmos1_href_16bit ) //output
);

//CMOS2
always@(posedge cmos2_pclk)
    begin
        cmos2_d_d0        <= cmos2_data_d2    ;
        cmos2_href_d0     <= cmos2_href_d2    ;
        cmos2_vsync_d0    <= cmos2_vsync_d2   ;
    end

cmos_8_16bit cmos2_8_16bit(
.pclk           (cmos2_pclk       ),//input
.rst_n          (cmos2_init_done),//input
.pdata_i        (cmos2_d_d0       ),//input[7:0]
.de_i           (cmos2_href_d0    ),//input
.vs_i           (cmos2_vsync_d0    ),//input

.pixel_clk      (cmos2_pclk_16bit ),//output
.pdata_o        (cmos2_d_16bit    ),//output[15:0]
.de_o           (cmos2_href_16bit ) //output
);


//CMOS3
always@(posedge cmos3_pclk)
    begin
        cmos3_d_d0        <= cmos3_data_d2    ;
        cmos3_href_d0     <= cmos3_href_d2    ;
        cmos3_vsync_d0    <= cmos3_vsync_d2   ;
    end

cmos_8_16bit_j2 cmos2_8_16bit_fmc(
.pclk           (cmos3_pclk       ),//input
.rst_n          (cmos3_init_done  ),//input
.pdata_i        (cmos3_d_d0       ),//input[7:0]
.de_i           (cmos3_href_d0    ),//input
.vs_i           (cmos3_vsync_d0    ),//input

.pixel_clk      (cmos3_pclk_16bit ),//output
.pdata_o        (cmos3_d_16bit    ),//output[15:0]
.de_o           (cmos3_href_16bit ) //output
);

// CMOS4
always @(posedge cmos4_pclk) begin
    cmos4_d_d0     <= cmos4_data_d2;
    cmos4_href_d0  <= cmos4_href_d2;
    cmos4_vsync_d0 <= cmos4_vsync_d2;
end

cmos_8_16bit_j2 cmos4_8_16bit_fmc(
    .pclk           (cmos4_pclk       ),
    .rst_n          (cmos4_init_done  ),
    .pdata_i        (cmos4_d_d0       ),
    .de_i           (cmos4_href_d0    ),
    .vs_i           (cmos4_vsync_d0   ),
    .pixel_clk      (cmos4_pclk_16bit ),
    .pdata_o        (cmos4_d_16bit    ),
    .de_o           (cmos4_href_16bit )
);

//===============================================================================
// 图像处理
//===============================================================================

/*
//SFP
image_process sfp_process(
        // 时钟与复位
    .pclk(clk_75m),        // 像素时钟
    .rst_n(lock && ddr_init_done),       // 复位信号，低有效

    // ---------------- 前端输入 (来自 CMOS) ----------------
    .vs_in(sfp_vs),       // 场同步信号 (VSYNC)
    .de_in(sfp_de),       // 数据有效信号 (HREF/DE)
    .data_in(sfp_rgb565),     // CMOS 拼接出的 16-bit 原始数据

    // ---------------- 后端输出 (去往 DDR 缓存) --------------
    .vs_out(vs_in_test_4),      // 处理后的场同步信号
    .de_out(de_in_test_4),      // 处理后的数据有效信号
    .data_out(i_rgb565_4)     // 处理后的标准 RGB565 数据
);
*/
//*==============================================================================

//===============================================================================
// 输出视频选择
//===============================================================================


// OV5640 emits BGR565. Convert to the DDR RGB565 field order first.  The
// first bring-up path is intentionally a direct camera-to-frame path: the
// adaptive ISP contains large 3x3 line-buffer logic that can fail P&R on
// this device, while it is not required to verify capture and display.
// KEY1 (M16) cycles the pixel processing mode for all four tiles. 10 ms at
// 50 MHz. The mode is committed at each camera's VSYNC boundary, so one
// frame is never composed from two different processing modes.
// This key is not board reset and not PCIe PERST. A press that blanks the
// picture is KEY0 / board_rst_n, which is a different button.
localparam [19:0] KEY1_DEBOUNCE_CYCLES = 20'd500_000;
localparam [3:0]  IMAGE_MODE_COUNT = 4'd9;
reg [1:0]  key1_sync;
reg [19:0] key1_cnt;
reg        key1_stable;
reg        key1_stable_d;
reg [3:0]  image_mode_request;

function [15:0] rgb565_to_gray;
    input [15:0] rgb;
    reg [7:0] r8;
    reg [7:0] g8;
    reg [7:0] b8;
    reg [7:0] y8;
    reg [16:0] y_sum;
    begin
        r8 = {rgb[15:11], rgb[15:13]};
        g8 = {rgb[10:5], rgb[10:9]};
        b8 = {rgb[4:0], rgb[4:2]};
        y_sum = (r8 * 8'd77) + (g8 * 8'd150) + (b8 * 8'd29);
        y8 = y_sum[15:8];
        rgb565_to_gray = {y8[7:3], y8[7:2], y8[7:3]};
    end
endfunction

function [15:0] process_rgb565;
    input [15:0] rgb;
    input [3:0] mode;
    reg [7:0] r8;
    reg [7:0] g8;
    reg [7:0] b8;
    reg [7:0] y8;
    reg [16:0] y_sum;
    reg [7:0] sepia_r;
    reg [7:0] sepia_g;
    reg [7:0] sepia_b;
    begin
        r8 = {rgb[15:11], rgb[15:13]};
        g8 = {rgb[10:5], rgb[10:9]};
        b8 = {rgb[4:0], rgb[4:2]};
        y_sum = (r8 * 8'd77) + (g8 * 8'd150) + (b8 * 8'd29);
        y8 = y_sum[15:8];
        sepia_r = (r8 > 8'd210) ? 8'd255 : r8 + 8'd45;
        sepia_g = (g8 > 8'd165) ? 8'd210 : g8 + 8'd45;
        sepia_b = (b8 > 8'd105) ? 8'd125 : b8 + 8'd20;
        case (mode)
            4'd0: process_rgb565 = rgb;                                  // 原始
            4'd1: process_rgb565 = rgb565_to_gray(rgb);                   // 灰度
            4'd2: process_rgb565 = {~rgb[15:11], ~rgb[10:5], ~rgb[4:0]};   // 反色
            4'd3: process_rgb565 = (y8 >= 8'd128) ? 16'hffff : 16'h0000;   // 全局二值
            4'd4: process_rgb565 = {rgb[15:11], 6'd0, 5'd0};               // 红色通道
            4'd5: process_rgb565 = {5'd0, rgb[10:5], 5'd0};                // 绿色通道
            4'd6: process_rgb565 = {5'd0, 6'd0, rgb[4:0]};                 // 蓝色通道
            4'd7: process_rgb565 = (y8 >= 8'd128) ? rgb : 16'h0000;        // 暗部抑制
            4'd8: process_rgb565 = {sepia_r[7:3], sepia_g[7:2],           // 暖色增强
                                    sepia_b[7:3]};
            default: process_rgb565 = rgb;
        endcase
    end
endfunction

always @(posedge clk_50m or negedge lock) begin
    if (!lock) begin
        key1_sync     <= 2'b11;
        key1_cnt      <= 20'd0;
        key1_stable   <= 1'b1;
        key1_stable_d <= 1'b1;
    end else begin
        key1_sync     <= {key1_sync[0], key1_n};
        key1_stable_d <= key1_stable;
        if (key1_sync[1] == key1_stable)
            key1_cnt <= 20'd0;
        else if (key1_cnt == KEY1_DEBOUNCE_CYCLES - 20'd1) begin
            key1_stable <= key1_sync[1];
            key1_cnt    <= 20'd0;
        end else
            key1_cnt <= key1_cnt + 20'd1;
    end
end

// key1_press is a one-cycle pulse after the debounced key falls.
wire key1_press = key1_stable_d & ~key1_stable;

always @(posedge clk_50m or negedge lock) begin
    if (!lock)
        image_mode_request <= 4'd0;
    else if (key1_press) begin
        if (image_mode_request == IMAGE_MODE_COUNT - 4'd1)
            image_mode_request <= 4'd0;
        else
            image_mode_request <= image_mode_request + 4'd1;
    end
end

assign cmos_init_done[0] = cmos3_init_done;

reg [3:0] image_mode_c1_meta, image_mode_c1_sync, image_mode_c1_active;
reg [3:0] image_mode_c2_meta, image_mode_c2_sync, image_mode_c2_active;
reg [3:0] image_mode_c3_meta, image_mode_c3_sync, image_mode_c3_active;
reg [3:0] image_mode_c4_meta, image_mode_c4_sync, image_mode_c4_active;
reg image_vsync_c1_d, image_vsync_c2_d, image_vsync_c3_d, image_vsync_c4_d;

always @(posedge cmos1_pclk_16bit or negedge lock) begin
    if (!lock) begin
        image_mode_c1_meta <= 4'd0;
        image_mode_c1_sync <= 4'd0;
        image_mode_c1_active <= 4'd0;
        image_vsync_c1_d <= 1'b0;
    end else begin
        image_mode_c1_meta <= image_mode_request;
        image_mode_c1_sync <= image_mode_c1_meta;
        image_vsync_c1_d <= cmos1_vsync_d0;
        if (cmos1_vsync_d0 && !image_vsync_c1_d)
            image_mode_c1_active <= image_mode_c1_sync;
    end
end
always @(posedge cmos2_pclk_16bit or negedge lock) begin
    if (!lock) begin
        image_mode_c2_meta <= 4'd0;
        image_mode_c2_sync <= 4'd0;
        image_mode_c2_active <= 4'd0;
        image_vsync_c2_d <= 1'b0;
    end else begin
        image_mode_c2_meta <= image_mode_request;
        image_mode_c2_sync <= image_mode_c2_meta;
        image_vsync_c2_d <= cmos2_vsync_d0;
        if (cmos2_vsync_d0 && !image_vsync_c2_d)
            image_mode_c2_active <= image_mode_c2_sync;
    end
end
always @(posedge cmos3_pclk_16bit or negedge lock) begin
    if (!lock) begin
        image_mode_c3_meta <= 4'd0;
        image_mode_c3_sync <= 4'd0;
        image_mode_c3_active <= 4'd0;
        image_vsync_c3_d <= 1'b0;
    end else begin
        image_mode_c3_meta <= image_mode_request;
        image_mode_c3_sync <= image_mode_c3_meta;
        image_vsync_c3_d <= cmos3_vsync_d0;
        if (cmos3_vsync_d0 && !image_vsync_c3_d)
            image_mode_c3_active <= image_mode_c3_sync;
    end
end
always @(posedge cmos4_pclk_16bit or negedge lock) begin
    if (!lock) begin
        image_mode_c4_meta <= 4'd0;
        image_mode_c4_sync <= 4'd0;
        image_mode_c4_active <= 4'd0;
        image_vsync_c4_d <= 1'b0;
    end else begin
        image_mode_c4_meta <= image_mode_request;
        image_mode_c4_sync <= image_mode_c4_meta;
        image_vsync_c4_d <= cmos4_vsync_d0;
        if (cmos4_vsync_d0 && !image_vsync_c4_d)
            image_mode_c4_active <= image_mode_c4_sync;
    end
end

assign     pclk_in_test    =    cmos1_pclk_16bit    ;
assign     cmos1_rgb565_raw =   {cmos1_d_16bit[4:0],cmos1_d_16bit[10:5],cmos1_d_16bit[15:11]};
assign     vs_in_test      =    cmos1_vsync_d0      ;
assign     de_in_test      =    cmos1_href_16bit    ;
assign     i_rgb565        =    process_rgb565(cmos1_rgb565_raw, image_mode_c1_active);

assign     pclk_in_test_2  =    cmos2_pclk_16bit    ;
assign     cmos2_rgb565_raw =   {cmos2_d_16bit[4:0],cmos2_d_16bit[10:5],cmos2_d_16bit[15:11]};
assign     vs_in_test_2    =    cmos2_vsync_d0      ;
assign     de_in_test_2    =    cmos2_href_16bit    ;
assign     i_rgb565_2      =    process_rgb565(cmos2_rgb565_raw, image_mode_c2_active);

assign     pclk_in_test_3  =    cmos3_pclk_16bit    ;
assign     vs_in_test_3    =    cmos3_vsync_d0      ;
assign     de_in_test_3    =    cmos3_href_16bit    ;
assign     i_rgb565_3      =    process_rgb565({cmos3_d_16bit[4:0],cmos3_d_16bit[10:5],cmos3_d_16bit[15:11]}, image_mode_c3_active);

assign     pclk_in_test_4  =    cmos4_pclk_16bit    ;
assign     vs_in_test_4    =    cmos4_vsync_d0      ;
assign     de_in_test_4    =    cmos4_href_16bit    ;
assign     i_rgb565_4      =    process_rgb565({cmos4_d_16bit[4:0],cmos4_d_16bit[10:5],cmos4_d_16bit[15:11]}, image_mode_c4_active);

//*==============================================================================
//ddr3 IP例化
//*==============================================================================
always@(posedge core_clk or negedge ddr_init_done)
begin
   if (!ddr_init_done)
      cnt <= 27'd0;
   else if ( cnt >= TH_1S )
      cnt <= 27'd0;
   else
      cnt <= cnt + 27'd1;
end

always @(posedge core_clk or negedge ddr_init_done)
begin
   if (!ddr_init_done)
      heart_beat_led <= 1'd1;
   else if ( cnt >= TH_1S )
      heart_beat_led <= ~heart_beat_led;
end
ddr3 #(
    .MEM_ROW_WIDTH              (MEM_ROW_WIDTH                ),
    .MEM_COLUMN_WIDTH           (MEM_COLUMN_WIDTH             ),
    .MEM_BANK_WIDTH             (MEM_BANK_WIDTH               ),
    .MEM_DQ_WIDTH               (MEM_DQ_WIDTH                 ),
    .MEM_DM_WIDTH               (MEM_DQS_WIDTH                ),
    .MEM_DQS_WIDTH              (MEM_DQS_WIDTH                ),
    .CTRL_ADDR_WIDTH            (CTRL_ADDR_WIDTH              )
  )I_ips_ddr_top(
    .ref_clk                    (free_clk                     ),
    .resetn                     (board_rst_n                  ),
    .core_clk                   (core_clk                     ),
    .pll_lock                   (pll_lock                     ),
    .phy_pll_lock               (phy_pll_lock                 ),
    .gpll_lock                  (gpll_lock                    ),
    .rst_gpll_lock              (rst_gpll_lock                ),
    .ddrphy_cpd_lock            (ddrphy_cpd_lock              ),
    .ddr_init_done              (ddr_init_done                ),

    .axi_awaddr                 (axi_awaddr                   ),
    .axi_awuser_ap              (axi_awuser_ap                ),
    .axi_awuser_id              (axi_awuser_id                ),
    .axi_awlen                  (axi_awlen                    ),
    .axi_awready                (axi_awready                  ),
    .axi_awvalid                (axi_awvalid                  ),

    .axi_wdata                  (axi_wdata                    ),
    .axi_wstrb                  (axi_wstrb                    ),
    .axi_wready                 (axi_wready                   ),
    .axi_wusero_id              (axi_wusero_id                ),
    .axi_wusero_last            (axi_wusero_last              ),

    .axi_araddr                 (axi_araddr                   ),
    .axi_aruser_ap              (axi_aruser_ap                ),
    .axi_aruser_id              (axi_aruser_id                ),
    .axi_arlen                  (axi_arlen                    ),
    .axi_arready                (axi_arready                  ),
    .axi_arvalid                (axi_arvalid                  ),

    .axi_rdata                  (axi_rdata                    ),
    .axi_rid                    (axi_rid                      ),
    .axi_rlast                  (axi_rlast                    ),
    .axi_rvalid                 (axi_rvalid                   ),

    .apb_clk                    (1'b0                         ),
    .apb_rst_n                  (1'b0                         ),
    .apb_sel                    (1'b0                         ),
    .apb_enable                 (1'b0                         ),
    .apb_addr                   (8'd0                         ),
    .apb_write                  (1'b0                         ),
    .apb_ready                  (                             ),
    .apb_wdata                  (16'd0                        ),
    .apb_rdata                  (                             ),


    .mem_cs_n                   (mem_cs_n                     ),

    .mem_rst_n                  (mem_rst_n                    ),
    .mem_ck                     (mem_ck                       ),
    .mem_ck_n                   (mem_ck_n                     ),
    .mem_cke                    (mem_cke                      ),
    .mem_ras_n                  (mem_ras_n                    ),
    .mem_cas_n                  (mem_cas_n                    ),
    .mem_we_n                   (mem_we_n                     ),
    .mem_odt                    (mem_odt                      ),
    .mem_a                      (mem_a                        ),
    .mem_ba                     (mem_ba                       ),
    .mem_dqs                    (mem_dqs                      ),
    .mem_dqs_n                  (mem_dqs_n                    ),
    .mem_dq                     (mem_dq                       ),
    .mem_dm                     (mem_dm                       ),

    //debug
    .dbg_gate_start             (1'b0                         ),
    .dbg_cpd_start              (1'b0                         ),
    .dbg_ddrphy_rst_n           (1'b1                         ),
    .dbg_gpll_scan_rst          (1'b0                         ),

    .samp_position_dyn_adj      (1'b0                         ),
    .init_samp_position_even    (16'd0                        ),
    .init_samp_position_odd     (16'd0                        ),

    .wrcal_position_dyn_adj     (1'b0                         ),
    .init_wrcal_position        (16'd0                        ),

    .force_read_clk_ctrl        (1'b0                         ),
    .init_slip_step             (8'd0                         ),
    .init_read_clk_ctrl         (6'd0                         ),

    .debug_calib_ctrl           (                             ),
    .dbg_dll_upd_state          (                             ),
    .dbg_slice_status           (                             ),
    .dbg_slice_state            (                             ),
    .debug_data                 (                             ),
    .debug_gpll_dps_phase       (                             ),

    .dbg_rst_dps_state          (                             ),
    .dbg_tran_err_rst_cnt       (                             ),
    .dbg_ddrphy_init_fail       (                             ),

    .debug_cpd_offset_adj       (1'b0                         ),
    .debug_cpd_offset_dir       (1'b0                         ),
    .debug_cpd_offset           (10'd0                        ),
    .debug_dps_cnt_dir0         (                             ),
    .debug_dps_cnt_dir1         (                             ),

    .ck_dly_en                  (1'b0                         ),
    .init_ck_dly_step           (8'd0                         ),
    .ck_dly_set_bin             (                             ),

    .align_error                (                             ),
    .debug_rst_state            (                             ),
    .debug_cpd_state            (                             )

  );


//*==============================================================================
// image_reshape
//*==============================================================================
image_reshape #(
    .HALF_SAMPLE_ENABLE     (1'b1                      )
) ch0_image_reshape(
    .clk                    (pclk_in_test               ),  
    .rst_n                  (lock   && ddr_init_done    ),

    .img_vs                 (vs_in_test                 ),
    .img_data_valid         (de_in_test                 ),     
    .img_data               (i_rgb565                   ),  
   
    .img_data_valid_out     (ch0_wframe_data_valid      ),
    .img_data_out           (ch0_wframe_data            )
);

image_reshape #(
    .HALF_SAMPLE_ENABLE     (1'b1                      )
) ch1_image_reshape(
    .clk                    (pclk_in_test_2             ),  
    .rst_n                  (lock   && ddr_init_done    ),

    .img_vs                 (vs_in_test_2               ),
    .img_data_valid         (de_in_test_2               ),     
    .img_data               (i_rgb565_2                 ),  
   
    .img_data_valid_out     (ch1_wframe_data_valid      ),
    .img_data_out           (ch1_wframe_data            )
);

image_reshape #(
    .HALF_SAMPLE_ENABLE     (1'b1                      )
) ch2_image_reshape(
    .clk                    (pclk_in_test_3             ),  
    .rst_n                  (lock && ddr_init_done      ),

    .img_vs                 (vs_in_test_3               ),
    .img_data_valid         (de_in_test_3               ),     
    .img_data               (i_rgb565_3                 ),  
   
    .img_data_valid_out     (ch2_wframe_data_valid      ),
    .img_data_out           (ch2_wframe_data            )
);

image_reshape #(
    .HALF_SAMPLE_ENABLE     (1'b1                      )
) ch3_image_reshape(
    .clk                    (pclk_in_test_4             ),  
    .rst_n                  (lock && ddr_init_done      ),

    .img_vs                 (vs_in_test_4               ),
    .img_data_valid         (de_in_test_4               ),     
    .img_data               (i_rgb565_4                 ),  
   
    .img_data_valid_out     (ch3_wframe_data_valid      ),
    .img_data_out           (ch3_wframe_data            )
);

video_frame_activity_watchdog #(
    .TIMEOUT_CYCLES             (SOURCE_ACTIVITY_TIMEOUT_CYCLES             )
) u_cmos1_frame_activity (
    .monitor_clk                (pclk_div2                                  ),
    .rst_n                      (core_rst_n                                 ),
    .frame_sync_async           (vs_in_test                                 ),
    .source_active              (cmos1_frame_active                         )
);

video_frame_activity_watchdog #(
    .TIMEOUT_CYCLES             (SOURCE_ACTIVITY_TIMEOUT_CYCLES             )
) u_cmos2_frame_activity (
    .monitor_clk                (pclk_div2                                  ),
    .rst_n                      (core_rst_n                                 ),
    .frame_sync_async           (vs_in_test_2                               ),
    .source_active              (cmos2_frame_active                         )
);

video_frame_activity_watchdog #(
    .TIMEOUT_CYCLES             (SOURCE_ACTIVITY_TIMEOUT_CYCLES             )
) u_cmos3_frame_activity (
    .monitor_clk                (pclk_div2                                  ),
    .rst_n                      (core_rst_n                                 ),
    .frame_sync_async           (vs_in_test_3                               ),
    .source_active              (cmos3_frame_active                         )
);

video_frame_activity_watchdog #(
    .TIMEOUT_CYCLES             (SOURCE_ACTIVITY_TIMEOUT_CYCLES             )
) u_cmos4_frame_activity (
    .monitor_clk                (pclk_div2                                  ),
    .rst_n                      (core_rst_n                                 ),
    .frame_sync_async           (vs_in_test_4                               ),
    .source_active              (cmos4_frame_active                         )
);

assign source_live_mask = CAMERA_SOURCE_MASK &
                          {cmos4_frame_active,
                           cmos3_frame_active,
                           cmos2_frame_active, cmos1_frame_active};
assign source_valid_mask = ddr_frame_valid_bitmap & source_live_mask;

always @(posedge pclk_div2 or negedge core_rst_n) begin
    if (!core_rst_n) begin
        source_valid_sync1 <= 4'd0;
        source_valid_sync2 <= 4'd0;
    end else begin
        source_valid_sync1 <= source_valid_mask;
        source_valid_sync2 <= source_valid_sync1;
    end
end

assign ddr_camera_frame_valid = |source_valid_sync2;

pcie_img_select #(
    .TILE_WIDTH                  (PCIE_TILE_WIDTH                           ),
    .TILE_HEIGHT                 (PCIE_TILE_HEIGHT                          ),
    .PIXELS_PER_BEAT             (PCIE_DMA_BEAT_BITS / PCIE_PIXEL_BITS      )
) pcie_img_select_inst(
    .clk                         (pclk_div2                                 ),
    .rst_n                       (core_rst_n                                ),
    .frame_start                 (frame_snapshot_start                      ),
    .source_mask                 (pcie_frame_source_mask                    ),

    .ch0_data_req                (ch0_rframe_data_en                        ),
    .ch0_data                    (ch0_rframe_data                           ),
    .ch0_data_valid              (ch0_rframe_data_valid                     ),
    .ch1_data_req                (ch1_rframe_data_en                        ),
    .ch1_data                    (ch1_rframe_data                           ),
    .ch1_data_valid              (ch1_rframe_data_valid                     ),
    .ch2_data_req                (ch2_rframe_data_en                        ),
    .ch2_data                    (ch2_rframe_data                           ),
    .ch2_data_valid              (ch2_rframe_data_valid                     ),
    .ch3_data_req                (ch3_rframe_data_en                        ),
    .ch3_data                    (ch3_rframe_data                           ),
    .ch3_data_valid              (ch3_rframe_data_valid                     ),

    .dma_wr_data_req             (image_dma_data_req                        ),
    .dma_wr_data                 (pcie_image_dma_data                       ),
    .stream_underflow            (pcie_stream_underflow                     )
);

assign image_dma_data_req = o_dma_write_data_req && !v2_metadata_mode;
assign i_dma_write_data = v2_metadata_mode ? v2_metadata_data :
                          pcie_image_dma_data;
//*==============================================================================
//axi控制器例化
//*==============================================================================
axi_ctrl_256_burst #(
      .FRAME_LEN                    (PCIE_TILE_FRAME_BEATS                   ),
      .MIRROR_CH3_TO_CH2           (1'b0                                    )
) axi_ctrl_inst
(
	  .ARESETN                     (ddr_init_done                             ),
	  .ACLK                        (core_clk                                  ),
	  .M_AXI_AWID                  (axi_awuser_id                             ),
	  .M_AXI_AWADDR                (axi_awaddr                                ),
	  .M_AXI_AWLEN                 (axi_awlen                                 ),
	  .M_AXI_AWSIZE                (                                          ),
	  .M_AXI_AWBURST               (                                          ),
	  .M_AXI_AWLOCK                (                                          ),
	  .M_AXI_AWCACHE               (                                          ),
	  .M_AXI_AWPROT                (                                          ),
	  .M_AXI_AWQOS                 (                                          ),
	  .M_AXI_AWUSER                (                                          ),
	  .M_AXI_AWVALID               (axi_awvalid                               ),
	  .M_AXI_AWREADY               (axi_awready                               ),
	  .M_AXI_WDATA                 (axi_wdata                                 ),
	  .M_AXI_WSTRB                 (axi_wstrb                                 ),
	  .M_AXI_WLAST                 (                                          ),
	  .M_AXI_WUSER                 (                                          ),
	  .M_AXI_WVALID                (                                          ),
	  .M_AXI_WREADY                (axi_wready                                ),
	  .M_AXI_BID                   (0                                         ),
	  .M_AXI_BRESP                 (0                                         ),
	  .M_AXI_BUSER                 (0                                         ),
      .M_AXI_BVALID                (1'b1                                      ),

	  .M_AXI_BREADY                (                                          ),
	  .M_AXI_ARID                  (axi_aruser_id                             ),
	  .M_AXI_ARADDR                (axi_araddr                                ),
	  .M_AXI_ARLEN                 (axi_arlen                                 ),
	  .M_AXI_ARSIZE                (                                          ),
	  .M_AXI_ARBURST               (                                          ),
	  .M_AXI_ARLOCK                (                                          ),
	  .M_AXI_ARCACHE               (                                          ),
	  .M_AXI_ARPROT                (                                          ),
	  .M_AXI_ARQOS                 (                                          ),
	  .M_AXI_ARUSER                (                                          ),
	  .M_AXI_ARVALID               (axi_arvalid                               ),
	  .M_AXI_ARREADY               (axi_arready                               ),
	  .M_AXI_RID                   (axi_rid                                   ),
	  .M_AXI_RDATA                 (axi_rdata                                 ),
	  .M_AXI_RRESP                 (0                                         ),
	  .M_AXI_RLAST                 (axi_rlast                                 ),
	  .M_AXI_RUSER                 (0                                         ),
	  .M_AXI_RVALID                (axi_rvalid                                ),
	  .M_AXI_RREADY                (                                          ),  

      // key
      .key                         ({1'b1,3'b111,4'b0000}                     ),
      .source_live_mask            (source_live_mask                         ),
      .read_source_mask            (ddr_read_source_mask                     ),

      // 通道0
      .ch0_wframe_pclk             (pclk_in_test                              ),
      .ch0_wframe_rst_n            (lock && ddr_init_done                     ),
      .ch0_wframe_vsync            (vs_in_test                                ),
      .ch0_wframe_data_valid       (ch0_wframe_data_valid                     ),         
      .ch0_wframe_data             (ch0_wframe_data                           ),

      .ch0_rframe_pclk             (pclk_div2                                 ),   
      .ch0_rframe_rst_n            (ddr_init_done                             ), 
      .ch0_rframe_vsync            (ch0_rframe_req                            ),
      .ch0_rframe_req              (ch0_rframe_req                            ),
      .ch0_rframe_req_ack          (ch0_rframe_req_ack                        ),
      .ch0_rframe_data_en          (ch0_rframe_fifo_read_en                   ),
      .ch0_rframe_data             (ch0_rframe_data                           ),      
      .ch0_rframe_data_valid       (ch0_rframe_data_valid                     ),
      .ch0_read_line_full          (line_full_flag_1                          ),
      .ch0_read_fifo_level         (ch0_read_fifo_level                       ),
      .ch0_read_complete           (ch0_read_complete                         ),

        // 通道1
      .ch1_wframe_pclk             (pclk_in_test_2                            ),
      .ch1_wframe_rst_n            (lock && ddr_init_done                     ),
      .ch1_wframe_vsync            (vs_in_test_2                              ),
      .ch1_wframe_data_valid       (ch1_wframe_data_valid                     ),          
      .ch1_wframe_data             (ch1_wframe_data                           ),      

      .ch1_rframe_pclk             (pclk_div2                                 ),   
      .ch1_rframe_rst_n            (ddr_init_done                             ), 
      .ch1_rframe_vsync            (ch1_rframe_req                            ),
      .ch1_rframe_req              (ch1_rframe_req                            ),
      .ch1_rframe_req_ack          (ch1_rframe_req_ack                        ),
      .ch1_rframe_data_en          (ch1_rframe_fifo_read_en                   ),
      .ch1_rframe_data             (ch1_rframe_data                           ),      
      .ch1_rframe_data_valid       (ch1_rframe_data_valid                     ),
      .ch1_read_line_full          (line_full_flag_2                          ),
      .ch1_read_fifo_level         (ch1_read_fifo_level                       ),
      .ch1_read_complete           (ch1_read_complete                         ),

      // 通道2
      .ch2_wframe_pclk             (pclk_in_test_3                            ),
      .ch2_wframe_rst_n            (lock && ddr_init_done                     ),
      .ch2_wframe_vsync            (vs_in_test_3                              ),
      .ch2_wframe_data_valid       (ch2_wframe_data_valid                     ),
      .ch2_wframe_data             (ch2_wframe_data                           ),

      .ch2_rframe_pclk             (pclk_div2                                 ),   
      .ch2_rframe_rst_n            (ddr_init_done                             ), 
      .ch2_rframe_vsync            (ch2_rframe_req                            ),
      .ch2_rframe_req              (ch2_rframe_req                            ),
      .ch2_rframe_req_ack          (ch2_rframe_req_ack                        ),
      .ch2_rframe_data_en          (ch2_rframe_fifo_read_en                   ),
      .ch2_rframe_data             (ch2_rframe_data                           ),      
      .ch2_rframe_data_valid       (ch2_rframe_data_valid                     ),
      .ch2_read_line_full          (line_full_flag_3                          ),
      .ch2_read_fifo_level         (ch2_read_fifo_level                       ),
      .ch2_read_complete           (ch2_read_complete                         ),

      // 通道3
      .ch3_wframe_pclk             (pclk_in_test_4                            ),  
      .ch3_wframe_rst_n            (lock && ddr_init_done                     ),
      .ch3_wframe_vsync            (vs_in_test_4                              ),
      .ch3_wframe_data_valid       (ch3_wframe_data_valid                     ),
      .ch3_wframe_data             (ch3_wframe_data                           ),

      .ch3_rframe_pclk             (pclk_div2                                 ),   
      .ch3_rframe_rst_n            (ddr_init_done                             ), 
      .ch3_rframe_vsync            (ch3_rframe_req                            ),
      .ch3_rframe_req              (ch3_rframe_req                            ),
      .ch3_rframe_req_ack          (ch3_rframe_req_ack                        ),
      .ch3_rframe_data_en          (ch3_rframe_fifo_read_en                   ),
      .ch3_rframe_data             (ch3_rframe_data                           ),      
      .ch3_rframe_data_valid       (ch3_rframe_data_valid                     ),
      .ch3_read_line_full          (line_full_flag_4                          ),
      .ch3_read_fifo_level         (ch3_read_fifo_level                       ),
      .ch3_read_complete           (ch3_read_complete                         ),
      .frame_valid_bitmap          (ddr_frame_valid_bitmap                    ),
      .all_frame_valid             (ddr_all_frame_valid                       )
);


//*==============================================================================
// pcie
//*==============================================================================
// Rst debounce
hsst_rst_cross_sync_v1_0 #(
    `ifdef IPS2L_PCIE_SPEEDUP_SIM
    .RST_CNTR_VALUE     (16'h10             )
    `else
    .RST_CNTR_VALUE     (16'hC000           )
    `endif
)
u_refclk_buttonrstn_debounce(
    .clk                (ref_clk            ),
    .rstn_in            (board_rst_n        ),
    .rstn_out           (sync_button_rst_n  )
);

hsst_rst_cross_sync_v1_0 #(
    `ifdef IPS2L_PCIE_SPEEDUP_SIM
    .RST_CNTR_VALUE     (16'h10             )
    `else
    .RST_CNTR_VALUE     (16'hC000           )
    `endif
)
u_refclk_perstn_debounce(
    .clk                (ref_clk            ),
    .rstn_in            (perst_n            ),
    .rstn_out           (sync_perst_n       )
);

hsst_rst_sync_v1_0  u_ref_core_rstn_sync    (
    .clk                (ref_clk            ),
    .rst_n              (core_rst_n         ),
    .sig_async          (1'b1               ),
    .sig_synced         (ref_core_rst_n     )
);

hsst_rst_sync_v1_0  u_pclk_core_rstn_sync   (
    .clk                (pclk               ),
    .rst_n              (core_rst_n         ),
    .sig_async          (1'b1               ),
    .sig_synced         (s_pclk_rstn        )
);

always @(posedge ref_clk or negedge sync_perst_n) begin
	if (!sync_perst_n) begin
		ref_led_cnt <= 23'd0;
		ref_led <= 1'b1;
	end else if (smlh_link_up & rdlh_link_up) begin
		ref_led_cnt <= ref_led_cnt + 23'd1;
		if(&ref_led_cnt)
			ref_led <= ~ref_led;
	end
end

always @(posedge pclk or negedge s_pclk_rstn) begin
	if (!s_pclk_rstn) begin
		pclk_led_cnt <= 27'd0;
		pclk_led <= 1'b1;
	end else if (smlh_link_up & rdlh_link_up) begin
		pclk_led_cnt <= pclk_led_cnt + 27'd1;
		if(&pclk_led_cnt)
			pclk_led <= ~pclk_led;
	end
end


//===========================================================================
//pcie dma
//===========================================================================
// DMA CTRL      BASE ADDR = 0x8000
ips2l_pcie_dma #(
	.DEVICE_TYPE			(DEVICE_TYPE),
	.AXIS_SLAVE_NUM			(AXIS_SLAVE_NUM)
) u_ips2l_pcie_dma (
	.clk					(pclk_div2),				
	.rst_n					(core_rst_n),				

	// Num
	.i_cfg_pbus_num			(cfg_pbus_num),				
	.i_cfg_pbus_dev_num		(cfg_pbus_dev_num),			
	.i_cfg_max_rd_req_size	(cfg_max_rd_req_size),		
	.i_cfg_max_payload_size	(cfg_max_payload_size),		

	// AXI4-Stream master interface
	.i_axis_master_tvld		(axis_master_tvalid_mem),	
	.o_axis_master_trdy		(axis_master_tready_mem),	
	.i_axis_master_tdata	(axis_master_tdata_mem),	
	.i_axis_master_tkeep	(axis_master_tkeep_mem),	
														
	.i_axis_master_tlast	(axis_master_tlast_mem),	
	.i_axis_master_tuser	(axis_master_tuser_mem),	

	// AXI4-Stream slave0 interface
	.i_axis_slave0_trdy		(axis_slave0_tready),		
	.o_axis_slave0_tvld		(dma_axis_slave0_tvalid),	
	.o_axis_slave0_tdata	(dma_axis_slave0_tdata),	
	.o_axis_slave0_tlast	(dma_axis_slave0_tlast),	
	.o_axis_slave0_tuser	(dma_axis_slave0_tuser),	

	// AXI4-Stream slave1 interface
	.i_axis_slave1_trdy		(axis_slave1_tready),		
	.o_axis_slave1_tvld		(axis_slave1_tvalid),		
	.o_axis_slave1_tdata	(axis_slave1_tdata),		
	.o_axis_slave1_tlast	(axis_slave1_tlast),		
	.o_axis_slave1_tuser	(axis_slave1_tuser),		

	// AXI4-Stream slave2 interface
	.i_axis_slave2_trdy		(axis_slave2_tready),		
	.o_axis_slave2_tvld		(axis_slave2_tvalid),		
	.o_axis_slave2_tdata	(axis_slave2_tdata),		
	.o_axis_slave2_tlast	(axis_slave2_tlast),		
	.o_axis_slave2_tuser	(axis_slave2_tuser),		

	// From pcie
	.i_cfg_ido_req_en		(cfg_ido_req_en),			
	.i_cfg_ido_cpl_en		(cfg_ido_cpl_en),			
	.i_xadm_ph_cdts			(xadm_ph_cdts),				
	.i_xadm_pd_cdts			(xadm_pd_cdts),				
	.i_xadm_nph_cdts		(xadm_nph_cdts),			
	.i_xadm_npd_cdts		(xadm_npd_cdts),			
	.i_xadm_cplh_cdts		(xadm_cplh_cdts),			
	.i_xadm_cpld_cdts		(xadm_cpld_cdts),			

	// APB interface
	.i_apb_psel				(p_sel_dma),				
	.i_apb_paddr			(p_addr[8:0]),				
	.i_apb_pwdata			(p_wdata),					
	.i_apb_pstrb			(p_strb),					
	.i_apb_pwrite			(p_we),						
	.i_apb_penable			(p_ce),						
	.o_apb_prdy				(p_rdy_dma),				
	.o_apb_prdata			(p_rdata_dma),				
	.o_cross_4kb_boundary	(cross_4kb_boundary),		//4k边界
    .i_auto_mwr_req         (v2_auto_mwr_req        ),
    .i_auto_mwr_length      (v2_auto_mwr_length     ),
    .i_auto_mwr_addr        (v2_auto_mwr_addr       ),
    .o_auto_mwr_req_ack     (v2_auto_mwr_req_ack    ),
    .o_auto_mwr_done        (v2_auto_mwr_done       ),
    .o_mwr_busy             (pcie_mwr_busy          ),
    .o_bar1_wr_en           (dma_bar1_wr_en         ),
    .o_bar1_wr_addr         (dma_bar1_wr_addr       ),
    .o_bar1_wr_data         (dma_bar1_wr_data       ),
    .o_bar1_wr_byte_en      (dma_bar1_wr_byte_en    ),
    .o_bar_rd_clk_en        (dma_bar_rd_clk_en      ),
    .o_bar_rd_addr          (dma_bar_rd_addr        ),
    .i_bar_rd_override      (v2_bar_rd_override     ),
    .i_bar_rd_data          (v2_bar_rd_data         ),
    //**********************************************************************
    // dma write interface
    .o_dma_write_data_req   (o_dma_write_data_req  ),
    .o_dma_write_addr       (o_dma_write_addr      ),
    .i_dma_write_data       (i_dma_write_data      )
);


pcie_frame_dma_v2 #(
    .CLK_HZ                      (125000000                              ),
    .TARGET_FPS                  (30                                     )
) pcie_frame_dma_v2_inst (
    .clk                         (pclk_div2                              ),
    .rst_n                       (core_rst_n                             ),
    .bar_wr_en                   (dma_bar1_wr_en                        ),
    .bar_wr_addr                 (dma_bar1_wr_addr                      ),
    .bar_wr_data                 (dma_bar1_wr_data                      ),
    .bar_wr_byte_en              (dma_bar1_wr_byte_en                   ),
    .bar_rd_clk_en               (dma_bar_rd_clk_en                     ),
    .bar_rd_addr                 (dma_bar_rd_addr                       ),
    .bar_rd_override             (v2_bar_rd_override                    ),
    .bar_rd_data                 (v2_bar_rd_data                        ),
    .source_valid_async          (source_valid_mask                     ),
    .snapshot_ack_async          ({ch3_rframe_req_ack, ch2_rframe_req_ack,
                                   ch1_rframe_req_ack, ch0_rframe_req_ack}),
    .read_complete_async         ({ch3_read_complete, ch2_read_complete,
                                   ch1_read_complete, ch0_read_complete}),
    .ch0_fifo_level              (ch0_read_fifo_level                   ),
    .ch1_fifo_level              (ch1_read_fifo_level                   ),
    .ch2_fifo_level              (ch2_read_fifo_level                   ),
    .ch3_fifo_level              (ch3_read_fifo_level                   ),
    .stream_underflow            (pcie_stream_underflow                 ),
    .frame_snapshot_req          (v2_frame_snapshot_req                 ),
    .frame_source_mask           (v2_frame_source_mask                  ),
    .snapshot_drain_mask         (v2_snapshot_drain_mask                ),
    .active                      (v2_active                             ),
    .auto_mwr_req                (v2_auto_mwr_req                       ),
    .auto_mwr_length             (v2_auto_mwr_length                    ),
    .auto_mwr_addr               (v2_auto_mwr_addr                      ),
    .auto_mwr_req_ack            (v2_auto_mwr_req_ack                   ),
    .auto_mwr_done               (v2_auto_mwr_done                      ),
    .auto_mwr_busy               (pcie_mwr_busy                         ),
    .dma_data_addr               (o_dma_write_addr                      ),
    .metadata_mode               (v2_metadata_mode                      ),
    .metadata_data               (v2_metadata_data                      ),
    .irq_pulse                   (v2_irq_pulse                          )
);

assign frame_snapshot_req = v2_active ? v2_frame_snapshot_req :
                            v1_frame_snapshot_req;
// V1 has no host-side source configuration.  V2 is also clamped here so a
// stale four-source configuration cannot request the absent CH2/CH3 inputs.
assign pcie_frame_source_mask = v2_active ?
                                (v2_frame_source_mask & CAMERA_SOURCE_MASK) :
                                v1_snapshot_source_mask;
assign ddr_read_source_mask = pcie_frame_source_mask;
assign ch0_rframe_req = frame_snapshot_req && pcie_frame_source_mask[0];
assign ch1_rframe_req = frame_snapshot_req && pcie_frame_source_mask[1];
assign ch2_rframe_req = frame_snapshot_req && pcie_frame_source_mask[2];
assign ch3_rframe_req = frame_snapshot_req && pcie_frame_source_mask[3];
assign frame_snapshot_start = frame_snapshot_req && !frame_snapshot_req_d;

// Empty any read transaction abandoned by V1 or by V2 recovery. Per-channel
// ACK masking prevents an early channel's newly selected frame from being
// consumed while another channel is still completing the handoff.
assign ch0_rframe_fifo_read_en = ch0_rframe_data_en ||
    (v2_snapshot_drain_mask[0] && (ch0_read_fifo_level != 11'd0));
assign ch1_rframe_fifo_read_en = ch1_rframe_data_en ||
    (v2_snapshot_drain_mask[1] && (ch1_read_fifo_level != 11'd0));
assign ch2_rframe_fifo_read_en = ch2_rframe_data_en ||
    (v2_snapshot_drain_mask[2] && (ch2_read_fifo_level != 11'd0));
assign ch3_rframe_fifo_read_en = ch3_rframe_data_en ||
    (v2_snapshot_drain_mask[3] && (ch3_read_fifo_level != 11'd0));

always @(posedge pclk_div2 or negedge core_rst_n) begin
    if (!core_rst_n)
        frame_snapshot_req_d <= 1'b0;
    else
        frame_snapshot_req_d <= frame_snapshot_req;
end



assign p_rdy_cfg               = 1'b0;
assign p_rdata_cfg             = 32'b0;

assign axis_slave0_tvalid      = dma_axis_slave0_tvalid;
assign axis_slave0_tlast       = dma_axis_slave0_tlast;
assign axis_slave0_tuser       = dma_axis_slave0_tuser;
assign axis_slave0_tdata       = dma_axis_slave0_tdata;

assign axis_master_tvalid_mem  = axis_master_tvalid;
assign axis_master_tdata_mem   = axis_master_tdata;
assign axis_master_tkeep_mem   = axis_master_tkeep;
assign axis_master_tlast_mem   = axis_master_tlast;
assign axis_master_tuser_mem   = axis_master_tuser;

assign axis_master_tready      = axis_master_tready_mem;



// PCIe IP TOP : HSSTLP : 0x0000~6000 PCIe BASE ADDR : 0x7000
pcie_test u_ips2l_pcie_wrap (
	.button_rst_n				(sync_button_rst_n),
	.power_up_rst_n				(sync_perst_n),
	.perst_n					(sync_perst_n),

	// The clock and reset signals
	.pclk						(pclk),					
	.pclk_div2					(pclk_div2),			
	.ref_clk					(ref_clk),				
	.ref_clk_n					(ref_clk_n),			
	.ref_clk_p					(ref_clk_p),			
	.core_rst_n					(core_rst_n),			

	// APB interface to DBI config
	.p_sel						(p_sel_pcie),			
	.p_strb						(uart_p_strb),			
	.p_addr						(uart_p_addr),			
	.p_wdata					(uart_p_wdata),			
	.p_ce						(uart_p_ce),			
	.p_we						(uart_p_we),			
	.p_rdy						(p_rdy_pcie),			
	.p_rdata					(p_rdata_pcie),			

	// PHY diff signals
	.rxn						(rxn),					
	.rxp						(rxp),					
	.txn						(txn),					
	.txp						(txp),					
	.pcs_nearend_loop			({4{1'b0}}),			
	.pma_nearend_ploop			({4{1'b0}}),			
	.pma_nearend_sloop			({4{1'b0}}),			

	// AXI4-Stream master interface
	.axis_master_tvalid			(axis_master_tvalid),	
	.axis_master_tready			(axis_master_tready),	
	.axis_master_tdata			(axis_master_tdata),	
	.axis_master_tkeep			(axis_master_tkeep),	
														
	.axis_master_tlast			(axis_master_tlast),	
	.axis_master_tuser			(axis_master_tuser),	

	// AXI4-Stream slave 0 interface
	.axis_slave0_tready			(axis_slave0_tready),	
	.axis_slave0_tvalid			(axis_slave0_tvalid),	
	.axis_slave0_tdata			(axis_slave0_tdata),	
	.axis_slave0_tlast			(axis_slave0_tlast),	
	.axis_slave0_tuser			(axis_slave0_tuser),	

	// AXI4-Stream slave 1 interface
	.axis_slave1_tready			(axis_slave1_tready),	
	.axis_slave1_tvalid			(axis_slave1_tvalid),	
	.axis_slave1_tdata			(axis_slave1_tdata),	
	.axis_slave1_tlast			(axis_slave1_tlast),	
	.axis_slave1_tuser			(axis_slave1_tuser),	

	// AXI4-Stream slave 2 interface
	.axis_slave2_tready			(axis_slave2_tready),	
	.axis_slave2_tvalid			(axis_slave2_tvalid),	
	.axis_slave2_tdata			(axis_slave2_tdata),	
	.axis_slave2_tlast			(axis_slave2_tlast),	
	.axis_slave2_tuser			(axis_slave2_tuser),	

	.pm_xtlh_block_tlp			(),						

	.cfg_send_cor_err_mux		(),						
	.cfg_send_nf_err_mux		(),						
	.cfg_send_f_err_mux			(),						
	.cfg_sys_err_rc				(),						
	.cfg_aer_rc_err_mux			(),						

	// The radm timeout
	.radm_cpl_timeout			(),						

	// Configuration signals
	.cfg_max_rd_req_size		(cfg_max_rd_req_size),	
	.cfg_bus_master_en			(),						
	.cfg_max_payload_size		(cfg_max_payload_size),	
	.cfg_ext_tag_en				(),						
	.cfg_rcb					(cfg_rcb),				
	.cfg_mem_space_en			(),						
	.cfg_pm_no_soft_rst			(),						
	.cfg_crs_sw_vis_en			(),						
	.cfg_no_snoop_en			(),						
	.cfg_relax_order_en			(),						
	.cfg_tph_req_en				(),						
	.cfg_pf_tph_st_mode			(),						
	.rbar_ctrl_update			(),						
	.cfg_atomic_req_en			(),						

	.cfg_pbus_num				(cfg_pbus_num),			
	.cfg_pbus_dev_num			(cfg_pbus_dev_num),		

	// Debug signals
	.radm_idle					(),						
	.radm_q_not_empty			(),						
	.radm_qoverflow				(),						
	.diag_ctrl_bus				(2'b0),					
	.cfg_link_auto_bw_mux		(),						
	.cfg_bw_mgt_mux				(),						
	.cfg_pme_mux				(),						
	.app_ras_des_sd_hold_ltssm	(1'b0),					
	.app_ras_des_tba_ctrl		(2'b0),					

	.dyn_debug_info_sel			(4'b0),					
	.debug_info_mux				(),

	// System signal
	.smlh_link_up				(smlh_link_up),			//link状态
	.rdlh_link_up				(rdlh_link_up),			//link状态
	.smlh_ltssm_state			(smlh_ltssm_state),
    // --- MSI 接口连接 ---
    .ven_msi_req      (msi_req_reg),     // 连接我们写的逻辑
     .ven_msi_grant    (msi_grant),       // IP核的应答
     .ven_msi_tc       (3'b000),          // 流量类别，默认0
     .ven_msi_vector   (5'b00000),        // 中断向量号，因为你只开了1个Vector，填0
     .cfg_msi_pending  (32'h0),           // 挂起状态，通常设为0
     .cfg_msi_en       (msi_enabled)     // Host是否使能了MSI状态输出
    ,.sfp_rx_data      (sfp_rx_data),
     .sfp_rx_datak     (sfp_rx_datak),
     .sfp_rx_valid     (sfp_rx_valid),
     .sfp_rx_clk       (sfp_rx_clk)
);



//=======================
reg  [11:0]  dma_write_cnt;  // 计数dma_write的次数

reg  [8:0]   line_beat_cnt;
wire         line_done_pulse;
wire         frame_done_pulse;
wire         legacy_irq_event;
reg          v1_snapshot_started;
reg  [3:0]   v1_snapshot_ack_seen;
wire [3:0]   v1_snapshot_ack_bus;

assign v1_snapshot_ack_bus = {
    ch3_rframe_req_ack,
    ch2_rframe_req_ack,
    ch1_rframe_req_ack,
    ch0_rframe_req_ack
} & v1_snapshot_source_mask;

assign line_done_pulse =
    image_dma_data_req && (line_beat_cnt == (PCIE_LINE_BEATS - 1));
assign frame_done_pulse =
    line_done_pulse && (dma_write_cnt == (PCIE_FRAME_HEIGHT - 1));
assign legacy_irq_event = frame_done_pulse && !v2_active;

always @(posedge pclk_div2 or negedge core_rst_n) begin
    if (!core_rst_n) begin
        dma_write_cnt <= 12'd0;
        line_beat_cnt <= 9'd0;
        v1_frame_snapshot_req <= 1'b0;
        v1_snapshot_started <= 1'b0;
        v1_snapshot_ack_seen <= 4'd0;
        v1_snapshot_source_mask <= 4'd0;
    end
    else if (v2_active) begin
        dma_write_cnt <= 12'd0;
        line_beat_cnt <= 9'd0;
        v1_frame_snapshot_req <= 1'b0;
        v1_snapshot_started <= 1'b0;
        v1_snapshot_ack_seen <= 4'd0;
        v1_snapshot_source_mask <= 4'd0;
    end
    else begin
        if (frame_done_pulse) begin
            dma_write_cnt <= 12'd0;
            if (!v1_frame_snapshot_req && (|source_valid_sync2)) begin
                v1_frame_snapshot_req <= 1'b1;
                v1_snapshot_source_mask <= source_valid_sync2;
                v1_snapshot_ack_seen <= 4'd0;
            end
        end
        else if (line_done_pulse)
            dma_write_cnt <= dma_write_cnt + 12'd1;

        if (line_done_pulse)
            line_beat_cnt <= 9'd0;
        else if (image_dma_data_req)
            line_beat_cnt <= line_beat_cnt + 9'd1;

        if (!v1_snapshot_started && ddr_camera_frame_valid) begin
            v1_frame_snapshot_req <= 1'b1;
            v1_snapshot_started <= 1'b1;
            v1_snapshot_source_mask <= source_valid_sync2;
            v1_snapshot_ack_seen <= 4'd0;
        end

        if (v1_frame_snapshot_req) begin
            v1_snapshot_ack_seen <= v1_snapshot_ack_seen |
                                    v1_snapshot_ack_bus;
            if (((v1_snapshot_ack_seen | v1_snapshot_ack_bus) &
                 v1_snapshot_source_mask) == v1_snapshot_source_mask) begin
                v1_frame_snapshot_req <= 1'b0;
                v1_snapshot_ack_seen <= 4'd0;
            end
        end
    end
end

// --- MSI 中断触发逻辑 ---
always @(posedge pclk_div2 or negedge core_rst_n) begin
    if (!core_rst_n) begin
        msi_req_reg <= 1'b0;
        msi_pending <= 1'b0;
    end
    else if (!msi_enabled) begin
        msi_req_reg <= 1'b0;
        msi_pending <= 1'b0;
    end else begin
        if (legacy_irq_event || (v2_active && v2_irq_pulse))
            msi_pending <= 1'b1;

        if (!msi_req_reg && msi_pending) begin
            msi_req_reg <= 1'b1;
            msi_pending <= 1'b0;
        end else if (msi_req_reg && msi_grant) begin
            msi_req_reg <= 1'b0;
        end
    end
end



endmodule
