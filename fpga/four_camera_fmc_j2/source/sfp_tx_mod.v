`timescale 1ns / 1ps
`define UD #1

module sfp_tx_mod(
    input  wire        pixclk,
    input  wire        rst,
    input  wire        en,
    input  wire        vs,
    input  wire        hs,
    input  wire        de,
    input  wire [7:0]  r,
    input  wire [7:0]  g,
    input  wire [7:0]  b,

    input  wire        hsst_clk,
    output wire [31:0] txd,
    output wire [3:0]  txk
);
    wire        tx_fifo_wr_full;
    wire        tx_fifo_rd_empty;
    wire [35:0] tx_fifo_wr_data;
    wire [35:0] tx_fifo_rd_data;
    wire        tx_fifo_wr_en;
    wire        tx_fifo_rd_en;

    sfp_video_tx u_sfp_video_tx (
        .pixclk       (pixclk          ),
        .rst          (rst             ),
        .en           (en              ),
        .vs           (vs              ),
        .hs           (hs              ),
        .de           (de              ),
        .r            (r               ),
        .g            (g               ),
        .b            (b               ),
        .fifo_full    (tx_fifo_wr_full ),
        .fifo_wr_en   (tx_fifo_wr_en   ),
        .fifo_wr_data (tx_fifo_wr_data ),
        .dbg_ctrl     (                ),
        .dbg_rgb565   (                )
    );

    async_fifo_tx u_async_fifo_tx (
        .wr_clk         (pixclk          ),
        .wr_rst         (rst             ),
        .wr_en          (tx_fifo_wr_en   ),
        .wr_data        (tx_fifo_wr_data ),
        .wr_full        (tx_fifo_wr_full ),
        .wr_water_level (                ),
        .almost_full    (                ),
        .rd_clk         (hsst_clk        ),
        .rd_rst         (rst             ),
        .rd_en          (tx_fifo_rd_en   ),
        .rd_data        (tx_fifo_rd_data ),
        .rd_empty       (tx_fifo_rd_empty),
        .rd_water_level (                ),
        .almost_empty   (                )
    );

    sfp_link_tx u_sfp_link_tx (
        .clk          (hsst_clk        ),
        .rst          (rst             ),
        .fifo_empty   (tx_fifo_rd_empty),
        .fifo_rd_en   (tx_fifo_rd_en   ),
        .fifo_rd_data (tx_fifo_rd_data ),
        .txd          (txd             ),
        .txk          (txk             )
    );
endmodule

