`timescale 1ns / 1ps

// FMC physical-layer diagnostic top level.
//
// The camera modules must be disconnected before programming this image.
// Every supported FMC camera signal is driven as a push-pull 1 kHz square
// wave. J2 and J3 use opposite phases so the two connectors are easy to tell
// apart on a scope. free_clk is the board's 25 MHz reference clock.
//
// SDA/SCL are deliberately driven as ordinary outputs for this physical
// continuity test; they are not I2C in this image.
module fmc_pin_diag (
    input        free_clk,
    input        board_rst_n,

    output [7:0] cmos3_data,
    output       cmos3_scl,
    output       cmos3_sda,
    output       cmos3_vsync,
    output       cmos3_href,
    output       cmos3_pclk,
    output       cmos3_reset,

    output [7:0] cmos4_data,
    output       cmos4_scl,
    output       cmos4_sda,
    output       cmos4_vsync,
    output       cmos4_href,
    output       cmos4_pclk,
    output       cmos4_reset
);

    // 25 MHz / (2 * 12,500) = 1 kHz.
    localparam integer HALF_PERIOD_CYCLES = 12_500;
    reg [13:0] divider;
    reg        diag_wave;

    always @(posedge free_clk or negedge board_rst_n) begin
        if (!board_rst_n) begin
            divider  <= 14'd0;
            diag_wave <= 1'b0;
        end else if (divider == HALF_PERIOD_CYCLES - 1) begin
            divider  <= 14'd0;
            diag_wave <= ~diag_wave;
        end else begin
            divider <= divider + 1'b1;
        end
    end

    // J2 is the cmos3 group. J3 is the cmos4 group and is phase-inverted.
    assign cmos3_data  = {8{diag_wave}};
    assign cmos3_scl   = diag_wave;
    assign cmos3_sda   = diag_wave;
    assign cmos3_vsync = diag_wave;
    assign cmos3_href  = diag_wave;
    assign cmos3_pclk  = diag_wave;
    assign cmos3_reset = diag_wave;

    assign cmos4_data  = {8{~diag_wave}};
    assign cmos4_scl   = ~diag_wave;
    assign cmos4_sda   = ~diag_wave;
    assign cmos4_vsync = ~diag_wave;
    assign cmos4_href  = ~diag_wave;
    assign cmos4_pclk  = ~diag_wave;
    assign cmos4_reset = ~diag_wave;

endmodule
