`timescale 1ns / 1ps

module ycbcr2rgb (
    input  wire        pclk, 
    input  wire        rst_n, 
    input  wire        vs_in, 
    input  wire        de_in,
    input  wire [7:0]  y_in, 
    input  wire [7:0]  cb_in, 
    input  wire [7:0]  cr_in,
    
    output reg         vs_out, 
    output reg         de_out,
    output reg  [15:0] rgb_out   // 输出 RGB565
);

    // ==========================================
    // Stage 1: 减去 128 (转为有符号数) 消耗 1 拍
    // 公式需要计算 (Cb-128) 和 (Cr-128)
    // ==========================================
    reg [7:0] y_d1;
    reg signed [8:0] cb_diff, cr_diff; // 必须是 9 位有符号数，防溢出
    reg vs_d1, de_d1;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_d1 <= 8'd0; cb_diff <= 9'sd0; cr_diff <= 9'sd0;
            vs_d1 <= 1'b0; de_d1 <= 1'b0;
        end else if (de_in) begin
            y_d1    <= y_in;
            // $signed 处理，确保减法被视作有符号运算
            cb_diff <= $signed({1'b0, cb_in}) - $signed(9'sd128);
            cr_diff <= $signed({1'b0, cr_in}) - $signed(9'sd128);
            vs_d1 <= vs_in; de_d1 <= de_in;
        end else begin
            vs_d1 <= vs_in; de_d1 <= 1'b0;
        end
    end

    // ==========================================
    // Stage 2: 乘法器 (有符号乘法) 消耗 1 拍
    // 使用定点数: R = Y + 1.402*Cr -> R = (256Y + 359Cr) >> 8
    // G = (256Y - 88Cb - 183Cr) >> 8
    // B = (256Y + 454Cb) >> 8
    // ==========================================
    reg signed [17:0] r_mult_cr;
    reg signed [17:0] g_mult_cb, g_mult_cr;
    reg signed [17:0] b_mult_cb;
    reg [7:0] y_d2;
    reg vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            r_mult_cr <= 18'sd0; g_mult_cb <= 18'sd0; 
            g_mult_cr <= 18'sd0; b_mult_cb <= 18'sd0;
            y_d2 <= 8'd0; vs_d2 <= 1'b0; de_d2 <= 1'b0;
        end else begin
            // 与常数进行有符号相乘
            r_mult_cr <= cr_diff * $signed(10'sd359);
            g_mult_cb <= cb_diff * $signed(10'sd88);
            g_mult_cr <= cr_diff * $signed(10'sd183);
            b_mult_cb <= cb_diff * $signed(10'sd454);
            
            y_d2  <= y_d1;
            vs_d2 <= vs_d1; de_d2 <= de_d1;
        end
    end

    // ==========================================
    // Stage 3: 累加、截断限幅 (Clamping) 与位拼接 消耗 1 拍
    // ==========================================
    // 先计算加法，保留 19 位有符号数以防止中间过程溢出
    wire signed [18:0] y_scaled = $signed({1'b0, y_d2, 8'd0}); // 等价于 Y * 256
    
    wire signed [18:0] r_sum = y_scaled + r_mult_cr;
    wire signed [18:0] g_sum = y_scaled - g_mult_cb - g_mult_cr;
    wire signed [18:0] b_sum = y_scaled + b_mult_cb;

    // 截断逻辑：小于 0 则为 0，大于 255 则为 255
    wire [7:0] r_clamp = (r_sum[18]) ? 8'd0 : (|r_sum[17:16]) ? 8'd255 : r_sum[15:8];
    wire [7:0] g_clamp = (g_sum[18]) ? 8'd0 : (|g_sum[17:16]) ? 8'd255 : g_sum[15:8];
    wire [7:0] b_clamp = (b_sum[18]) ? 8'd0 : (|b_sum[17:16]) ? 8'd255 : b_sum[15:8];

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            rgb_out <= 16'd0;
            vs_out <= 1'b0; de_out <= 1'b0;
        end else begin
            // 组装成 RGB565 格式输出
            rgb_out <= {r_clamp[7:3], g_clamp[7:2], b_clamp[7:3]};
            vs_out  <= vs_d2;
            de_out  <= de_d2;
        end
    end

endmodule