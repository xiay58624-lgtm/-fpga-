`timescale 1ns / 1ps

module gray2rgb565 (
    input  wire        pclk,
    input  wire        rst_n,
    
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [7:0]  data_in,
    
    output reg         vs_out,
    output reg         de_out,
    output reg  [15:0] data_out
);
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out   <= 1'b0;
            de_out   <= 1'b0;
            data_out <= 16'd0;
        end else begin
            // 控制信号继续打一拍
            vs_out   <= vs_in;
            de_out   <= de_in;
            
            // 取灰度值的高位重新拼成 RGB565: R(5bit), G(6bit), B(5bit)
            // 因为现在 R=G=B (灰度图)，所以色彩是黑白的
            data_out <= {data_in[7:3], data_in[7:2], data_in[7:3]};
        end
    end
endmodule