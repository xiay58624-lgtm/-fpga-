`timescale 1ns / 1ps

module rgb2gray (
    input  wire        pclk,
    input  wire        rst_n,
    
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [15:0] data_in,
    
    output reg         vs_out,
    output reg         de_out,
    output reg  [7:0]  data_out
);
    // 提取 RGB 分量并高位补齐扩展到 8 bit
    wire [7:0] r = {data_in[15:11], data_in[13:11]};
    wire [7:0] g = {data_in[10:5],  data_in[6:5]};
    wire [7:0] b = {data_in[4:0],   data_in[2:0]};

    // 灰度化公式 Gray = (R*76 + G*150 + B*30) >> 8
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out   <= 1'b0;
            de_out   <= 1'b0;
            data_out <= 8'd0;
        end else begin
            // 控制信号打一拍，和加法计算的延迟保持一致
            vs_out   <= vs_in;
            de_out   <= de_in;
            
            if (de_in)
                data_out <= (r * 16'd76 + g * 16'd150 + b * 16'd30) >> 8;
            else
                data_out <= 8'd0;
        end
    end
endmodule