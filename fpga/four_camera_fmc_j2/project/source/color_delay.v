`timescale 1ns / 1ps
module color_delay #(
    parameter [10:0] IMG_WIDTH = 11'd1280
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [7:0]  cb_in,
    input  wire [7:0]  cr_in,
    
    output reg         vs_out,
    output reg         de_out,
    output wire [7:0]  cb_out,
    output wire [7:0]  cr_out
);
    reg [7:0] cb_buf [0:1279];
    reg [7:0] cr_buf [0:1279];
    reg [10:0] ptr;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) ptr <= 11'd0;
        else if (de_in) begin
            cb_buf[ptr] <= cb_in;
            cr_buf[ptr] <= cr_in;
            ptr <= (ptr == IMG_WIDTH - 1) ? 11'd0 : ptr + 1'b1;
        end else ptr <= 11'd0;
    end

    reg [7:0] cb_d1, cb_d2, cb_d3;
    reg [7:0] cr_d1, cr_d2, cr_d3;
    reg [3:0] vs_sr, de_sr;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {cb_d3, cb_d2, cb_d1} <= 24'd0; {cr_d3, cr_d2, cr_d1} <= 24'd0;
            vs_sr <= 4'b0; de_sr <= 4'b0; vs_out <= 1'b0; de_out <= 1'b0;
        end else begin
            {cb_d3, cb_d2, cb_d1} <= {cb_d2, cb_d1, cb_buf[ptr]};
            {cr_d3, cr_d2, cr_d1} <= {cr_d2, cr_d1, cr_buf[ptr]};
            vs_sr <= {vs_sr[2:0], vs_in};
            de_sr <= {de_sr[2:0], de_in};
            vs_out <= vs_sr[3];
            de_out <= de_sr[3];
        end
    end

    assign cb_out = cb_d3;
    assign cr_out = cr_d3;
endmodule