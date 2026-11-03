`timescale 1ns / 1ps
module matrix_3x3 #(
    parameter [10:0] IMG_WIDTH = 11'd1280
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        de_in,
    input  wire [7:0]  data_in,
    
    output reg  [7:0]  p11, p12, p13,
    output reg  [7:0]  p21, p22, p23,
    output reg  [7:0]  p31, p32, p33
);
    reg [7:0] line_buf_1 [0:1279];
    reg [7:0] line_buf_2 [0:1279];
    reg [10:0] col_cnt;

    wire [7:0] row1_v = line_buf_1[col_cnt];
    wire [7:0] row2_v = line_buf_2[col_cnt];

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) col_cnt <= 11'd0;
        else if (de_in) begin
            line_buf_1[col_cnt] <= row2_v;
            line_buf_2[col_cnt] <= data_in;
            col_cnt <= (col_cnt == IMG_WIDTH - 1) ? 11'd0 : col_cnt + 1'b1;
        end else col_cnt <= 11'd0;
    end

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {p11,p12,p13} <= 24'd0; {p21,p22,p23} <= 24'd0; {p31,p32,p33} <= 24'd0;
        end else if (de_in) begin
            {p11, p12, p13} <= {p12, p13, row1_v};
            {p21, p22, p23} <= {p22, p23, row2_v};
            {p31, p32, p33} <= {p32, p33, data_in};
        end
    end
endmodule