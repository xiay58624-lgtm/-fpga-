`timescale 1ns / 1ps

module rgb2ycbcr (
    input  wire        pclk, 
    input  wire        rst_n, 
    input  wire        vs_in, 
    input  wire        de_in,
    input  wire [15:0] rgb_in,   // 输入 RGB565
    
    output reg         vs_out, 
    output reg         de_out,
    output reg  [7:0]  y_out, 
    output reg  [7:0]  cb_out, 
    output reg  [7:0]  cr_out
);

    // ==========================================
    // Stage 1: 输入数据解包与扩宽 (消耗 1 拍)
    // ==========================================
    reg [7:0] r_reg, g_reg, b_reg;
    reg vs_d1, de_d1;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            r_reg <= 8'd0; g_reg <= 8'd0; b_reg <= 8'd0;
            vs_d1 <= 1'b0; de_d1 <= 1'b0;
        end else if (de_in) begin
            // RGB565 转 RGB888 (低位补偿)
            r_reg <= {rgb_in[4:0],   rgb_in[2:0]};
            g_reg <= {rgb_in[10:5],  rgb_in[6:5]};  
            b_reg <= {rgb_in[15:11], rgb_in[13:11]};    
            vs_d1 <= vs_in;
            de_d1 <= de_in;
        end else begin
            vs_d1 <= vs_in; de_d1 <= 1'b0;
        end
    end

    // ==========================================
    // Stage 2: 乘法运算映射到 DSP (消耗 1 拍)
    // ==========================================
    reg [15:0] y_r, y_g, y_b;
    reg [15:0] cb_r, cb_g, cb_b;
    reg [15:0] cr_r, cr_g, cr_b;
    reg vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_r <= 16'd0; y_g <= 16'd0; y_b <= 16'd0;
            cb_r <= 16'd0; cb_g <= 16'd0; cb_b <= 16'd0;
            cr_r <= 16'd0; cr_g <= 16'd0; cr_b <= 16'd0;
            vs_d2 <= 1'b0; de_d2 <= 1'b0;
        end else begin
            y_r  <= r_reg * 8'd77;  y_g  <= g_reg * 8'd150; y_b  <= b_reg * 8'd29;
            cb_r <= r_reg * 8'd43;  cb_g <= g_reg * 8'd85;  cb_b <= b_reg * 8'd128;
            cr_r <= r_reg * 8'd128; cr_g <= g_reg * 8'd107; cr_b <= b_reg * 8'd21;
            vs_d2 <= vs_d1; de_d2 <= de_d1;
        end
    end

    // ==========================================
    // Stage 3: 加减法树与移位 (消耗 1 拍)
    // ==========================================
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_out <= 8'd0; cb_out <= 8'd0; cr_out <= 8'd0;
            vs_out <= 1'b0; de_out <= 1'b0;
        end else begin
            y_out  <= (y_r + y_g + y_b) >> 8;
            cb_out <= (cb_b + 16'd32768 - cb_r - cb_g) >> 8;
            cr_out <= (cr_r + 16'd32768 - cr_g - cr_b) >> 8;
            vs_out <= vs_d2; de_out <= de_d2;
        end
    end

endmodule