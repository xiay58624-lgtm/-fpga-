`timescale 1ns / 1ps
module median_sort(
    input  wire       clk,
    input  wire       rst_n,
    input  wire [7:0] p11, p12, p13, p21, p22, p23, p31, p32, p33,
    output wire [7:0] result
);
    wire [7:0] max1, mid1, min1, max2, mid2, min2, max3, mid3, min3;
    wire [7:0] min_max, mid_mid, max_min;

    sort_unit u1(.clk(clk), .rst_n(rst_n), .a(p11), .b(p12), .c(p13), .max(max1), .mid(mid1), .min(min1));
    sort_unit u2(.clk(clk), .rst_n(rst_n), .a(p21), .b(p22), .c(p23), .max(max2), .mid(mid2), .min(min2));
    sort_unit u3(.clk(clk), .rst_n(rst_n), .a(p31), .b(p32), .c(p33), .max(max3), .mid(mid3), .min(min3));

    sort_unit u4(.clk(clk), .rst_n(rst_n), .a(max1), .b(max2), .c(max3), .max(), .mid(), .min(min_max));
    sort_unit u5(.clk(clk), .rst_n(rst_n), .a(mid1), .b(mid2), .c(mid3), .max(), .mid(mid_mid), .min());
    sort_unit u6(.clk(clk), .rst_n(rst_n), .a(min1), .b(min2), .c(min3), .max(max_min), .mid(), .min());

    sort_unit u7(.clk(clk), .rst_n(rst_n), .a(min_max), .b(mid_mid), .c(max_min), .max(), .mid(result), .min());
endmodule