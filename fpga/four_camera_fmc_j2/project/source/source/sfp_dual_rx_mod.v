`timescale 1ns / 1ps

module sfp_dual_rx_mod(
    input  wire        hsst_clk,
    input  wire        parser_rst,
    input  wire        fifo3_wr_rst,
    input  wire        fifo3_rd_rst,
    input  wire        fifo4_wr_rst,
    input  wire        fifo4_rd_rst,
    input  wire [31:0] rxd,
    input  wire [3:0]  rxk,

    input  wire        pixclk,

    input  wire        fifo3_rd_en,
    output wire        fifo3_empty,
    output wire [35:0] fifo3_rd_data,
    output wire [13:0] fifo3_rd_level,

    input  wire        fifo4_rd_en,
    output wire        fifo4_empty,
    output wire [35:0] fifo4_rd_data,
    output wire [13:0] fifo4_rd_level,

    output wire        rx3_packet_activity,
    output wire        rx4_packet_activity
);
    wire        fifo3_wr_full;
    wire        fifo3_wr_en;
    wire [35:0] fifo3_wr_data;
    wire        fifo4_wr_full;
    wire        fifo4_wr_en;
    wire [35:0] fifo4_wr_data;

    sfp_dual_link_rx u_sfp_dual_link_rx (
        .clk           (hsst_clk     ),
        .rst           (parser_rst   ),
        .ch3_rst       (fifo3_wr_rst ),
        .ch4_rst       (fifo4_wr_rst ),
        .rxd           (rxd          ),
        .rxk           (rxk          ),
        .fifo3_full    (fifo3_wr_full),
        .fifo3_wr_en   (fifo3_wr_en  ),
        .fifo3_wr_data (fifo3_wr_data),
        .fifo4_full    (fifo4_wr_full),
        .fifo4_wr_en   (fifo4_wr_en  ),
        .fifo4_wr_data (fifo4_wr_data),
        .rx3_packet_activity(rx3_packet_activity),
        .rx4_packet_activity(rx4_packet_activity),
        .rx_packet_activity()
    );

    async_fifo_rx u_async_fifo_rx3 (
        .wr_clk         (hsst_clk      ),
        .wr_rst         (fifo3_wr_rst  ),
        .wr_en          (fifo3_wr_en   ),
        .wr_data        (fifo3_wr_data ),
        .wr_full        (fifo3_wr_full ),
        .wr_water_level (              ),
        .almost_full    (              ),
        .rd_clk         (pixclk        ),
        .rd_rst         (fifo3_rd_rst  ),
        .rd_en          (fifo3_rd_en   ),
        .rd_data        (fifo3_rd_data ),
        .rd_empty       (fifo3_empty   ),
        .rd_water_level (fifo3_rd_level),
        .almost_empty   (              )
    );

    async_fifo_rx u_async_fifo_rx4 (
        .wr_clk         (hsst_clk      ),
        .wr_rst         (fifo4_wr_rst  ),
        .wr_en          (fifo4_wr_en   ),
        .wr_data        (fifo4_wr_data ),
        .wr_full        (fifo4_wr_full ),
        .wr_water_level (              ),
        .almost_full    (              ),
        .rd_clk         (pixclk        ),
        .rd_rst         (fifo4_rd_rst  ),
        .rd_en          (fifo4_rd_en   ),
        .rd_data        (fifo4_rd_data ),
        .rd_empty       (fifo4_empty   ),
        .rd_water_level (fifo4_rd_level),
        .almost_empty   (              )
    );
endmodule
