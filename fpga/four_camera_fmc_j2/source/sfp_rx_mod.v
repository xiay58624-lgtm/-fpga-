`timescale 1ns / 1ps
`define UD #1

module sfp_rx_mod(
    input  wire        hsst_clk,
    input  wire        rst,
    input  wire [31:0] rxd,
    input  wire [3:0]  rxk,

    input  wire        pixclk,
    input  wire        fifo_rd_en,
    output wire        fifo_empty,
    output wire [35:0] fifo_rd_data,
    output wire [13:0] fifo_rd_level
);
    wire        rx_fifo_wr_full;
    wire [35:0] rx_fifo_wr_data;
    wire        rx_fifo_wr_en;

    sfp_link_rx u_sfp_link_rx (
        .clk          (hsst_clk        ),
        .rst          (rst             ),
        .rxd          (rxd             ),
        .rxk          (rxk             ),
        .fifo_full    (rx_fifo_wr_full ),
        .fifo_wr_en   (rx_fifo_wr_en   ),
        .fifo_wr_data (rx_fifo_wr_data )
    );

    async_fifo_rx u_async_fifo_rx (
        .wr_clk         (hsst_clk        ),
        .wr_rst         (rst             ),
        .wr_en          (rx_fifo_wr_en   ),
        .wr_data        (rx_fifo_wr_data ),
        .wr_full        (rx_fifo_wr_full ),
        .wr_water_level (                ),
        .almost_full    (                ),
        .rd_clk         (pixclk          ),
        .rd_rst         (rst             ),
        .rd_en          (fifo_rd_en      ),
        .rd_data        (fifo_rd_data    ),
        .rd_empty       (fifo_empty      ),
        .rd_water_level (fifo_rd_level   ),
        .almost_empty   (                )
    );
endmodule

