`timescale 1ns / 1ps
`define UD #1

module hdmi_out_mod(
    input  wire        pixclk,
    input  wire        rst,
    input  wire        en,

    input  wire        fifo_empty,
    output wire        fifo_rd_en,
    input  wire [35:0] fifo_rd_data,

    output wire        vs_out,
    output wire        hs_out,
    output wire        de_out,
    output wire [7:0]  r_out,
    output wire [7:0]  g_out,
    output wire [7:0]  b_out
);
    wire [35:0] dbg_word_rx   /*synthesis PAP_MARK_DEBUG="true"*/;
    wire [7:0]  dbg_ctrl_rx   /*synthesis PAP_MARK_DEBUG="true"*/;
    wire [15:0] dbg_rgb565_rx /*synthesis PAP_MARK_DEBUG="true"*/;

    sfp_video_rx u_sfp_video_rx (
        .pixclk       (pixclk      ),
        .rst          (rst         ),
        .en           (en          ),
        .fifo_empty   (fifo_empty  ),
        .fifo_rd_en   (fifo_rd_en  ),
        .fifo_rd_data (fifo_rd_data),
        .vs           (vs_out      ),
        .hs           (hs_out      ),
        .de           (de_out      ),
        .r            (r_out       ),
        .g            (g_out       ),
        .b            (b_out       ),
        .dbg_word     (dbg_word_rx ),
        .dbg_ctrl     (dbg_ctrl_rx ),
        .dbg_rgb565   (dbg_rgb565_rx)
    );
endmodule

