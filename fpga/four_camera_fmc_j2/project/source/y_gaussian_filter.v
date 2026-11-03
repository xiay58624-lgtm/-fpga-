`timescale 1ns / 1ps

module y_gaussian_filter #(
    parameter IMG_WIDTH = 1280,
    parameter integer FILTER_LUMA = 1,
    parameter integer BYPASS_BORDER = 0
)(
    input  wire        pclk,
    input  wire        rst_n,
    
    // 输入接口 (连接 中值滤波的输出)
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [7:0]  y_in,
    input  wire [7:0]  cb_in,
    input  wire [7:0]  cr_in,
    
    // 输出接口 (连接 YCbCr2RGB)
    output reg         vs_out,
    output reg         de_out,
    output reg  [7:0]  y_out,
    output reg  [7:0]  cb_out,
    output reg  [7:0]  cr_out
);

    // ==========================================
    // 1. 同步行缓存 (Double Line Buffer) - 三通道独立
    // ==========================================
    reg  [10:0] wr_ptr;      
    reg  [10:0] wr_ptr_d1;   
    reg         vs_d1, de_d1;
    reg  [10:0] active_x;
    reg  [10:0] active_y;
    reg         de_in_d;
    reg  [3:0]  kernel_valid_pipe;
    reg  [7:0]  y_bypass_d1, y_bypass_d2, y_bypass_d3, y_bypass_d4;
    reg  [7:0]  cb_bypass_d1, cb_bypass_d2, cb_bypass_d3, cb_bypass_d4;
    reg  [7:0]  cr_bypass_d1, cr_bypass_d2, cr_bypass_d3, cr_bypass_d4;
    
    // 第三行直接用输入数据延迟得到
    reg  [7:0]  y_row3, cb_row3, cr_row3;   
    // 第一、二行从 BRAM 中读出
    wire [7:0]  y_row2, cb_row2, cr_row2;   
    wire [7:0]  y_row1, cb_row1, cr_row1;   

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= 11'd0; wr_ptr_d1 <= 11'd0;
            vs_d1 <= 1'b0; de_d1 <= 1'b0;
            active_x <= 11'd0; active_y <= 11'd0; de_in_d <= 1'b0;
            kernel_valid_pipe <= 4'b0000;
            {y_bypass_d1, y_bypass_d2, y_bypass_d3, y_bypass_d4} <= 32'd0;
            {cb_bypass_d1, cb_bypass_d2, cb_bypass_d3, cb_bypass_d4} <= 32'd0;
            {cr_bypass_d1, cr_bypass_d2, cr_bypass_d3, cr_bypass_d4} <= 32'd0;
            {y_row3, cb_row3, cr_row3} <= 24'd0;
        end else begin
            vs_d1 <= vs_in; de_d1 <= de_in;
            de_in_d <= de_in;
            if (vs_in) begin
                wr_ptr <= 11'd0;
                active_x <= 11'd0;
                active_y <= 11'd0;
            end else if (de_in) begin
                wr_ptr <= (wr_ptr == IMG_WIDTH - 1) ? 11'd0 : wr_ptr + 1'b1;
                active_x <= (active_x == IMG_WIDTH - 1) ? 11'd0 : active_x + 1'b1;
            end
            if (!vs_in && de_in_d && !de_in) begin
                active_y <= active_y + 1'b1;
            end
            wr_ptr_d1 <= wr_ptr; 
            {y_row3, cb_row3, cr_row3} <= {y_in, cb_in, cr_in};   
            kernel_valid_pipe <= {
                kernel_valid_pipe[2:0],
                de_in && (active_x >= 11'd2) && (active_y >= 11'd2)
            };
            y_bypass_d1 <= y_in;
            y_bypass_d2 <= y_bypass_d1;
            y_bypass_d3 <= y_bypass_d2;
            y_bypass_d4 <= y_bypass_d3;
            cb_bypass_d1 <= cb_in;
            cb_bypass_d2 <= cb_bypass_d1;
            cb_bypass_d3 <= cb_bypass_d2;
            cb_bypass_d4 <= cb_bypass_d3;
            cr_bypass_d1 <= cr_in;
            cr_bypass_d2 <= cr_bypass_d1;
            cr_bypass_d3 <= cr_bypass_d2;
            cr_bypass_d4 <= cr_bypass_d3;
        end
    end

    // --- Y 通道缓存 ---
    line_buf u_y_buf_1 ( .wr_data(y_in),    .wr_addr(wr_ptr),    .wr_en(de_in), .wr_clk(pclk), .wr_rst(~rst_n), .rd_addr(wr_ptr), .rd_data(y_row2), .rd_clk(pclk), .rd_rst(~rst_n) );
    line_buf u_y_buf_2 ( .wr_data(y_row2),  .wr_addr(wr_ptr_d1), .wr_en(de_d1), .wr_clk(pclk), .wr_rst(~rst_n), .rd_addr(wr_ptr), .rd_data(y_row1), .rd_clk(pclk), .rd_rst(~rst_n) );

    // --- Cb 通道缓存 ---
    line_buf u_cb_buf_1( .wr_data(cb_in),   .wr_addr(wr_ptr),    .wr_en(de_in), .wr_clk(pclk), .wr_rst(~rst_n), .rd_addr(wr_ptr), .rd_data(cb_row2), .rd_clk(pclk), .rd_rst(~rst_n) );
    line_buf u_cb_buf_2( .wr_data(cb_row2), .wr_addr(wr_ptr_d1), .wr_en(de_d1), .wr_clk(pclk), .wr_rst(~rst_n), .rd_addr(wr_ptr), .rd_data(cb_row1), .rd_clk(pclk), .rd_rst(~rst_n) );

    // --- Cr 通道缓存 ---
    line_buf u_cr_buf_1( .wr_data(cr_in),   .wr_addr(wr_ptr),    .wr_en(de_in), .wr_clk(pclk), .wr_rst(~rst_n), .rd_addr(wr_ptr), .rd_data(cr_row2), .rd_clk(pclk), .rd_rst(~rst_n) );
    line_buf u_cr_buf_2( .wr_data(cr_row2), .wr_addr(wr_ptr_d1), .wr_en(de_d1), .wr_clk(pclk), .wr_rst(~rst_n), .rd_addr(wr_ptr), .rd_data(cr_row1), .rd_clk(pclk), .rd_rst(~rst_n) );


    // ==========================================
    // 2. 3x3 矩阵窗口生成 - 消耗 1 拍
    // ==========================================
    reg [7:0] y_p11, y_p12, y_p13, y_p21, y_p22, y_p23, y_p31, y_p32, y_p33;
    reg [7:0] cb_p11, cb_p12, cb_p13, cb_p21, cb_p22, cb_p23, cb_p31, cb_p32, cb_p33;
    reg [7:0] cr_p11, cr_p12, cr_p13, cr_p21, cr_p22, cr_p23, cr_p31, cr_p32, cr_p33;
    reg vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_d2 <= 0; de_d2 <= 0;
            {y_p11, y_p12, y_p13, y_p21, y_p22, y_p23,
             y_p31, y_p32, y_p33} <= 72'd0;
            {cb_p11, cb_p12, cb_p13, cb_p21, cb_p22, cb_p23,
             cb_p31, cb_p32, cb_p33} <= 72'd0;
            {cr_p11, cr_p12, cr_p13, cr_p21, cr_p22, cr_p23,
             cr_p31, cr_p32, cr_p33} <= 72'd0;
        end else begin
            vs_d2 <= vs_d1; de_d2 <= de_d1;
            if (de_d1) begin
                y_p13 <= y_p12; y_p12 <= y_p11; y_p11 <= y_row1;
                y_p23 <= y_p22; y_p22 <= y_p21; y_p21 <= y_row2;
                y_p33 <= y_p32; y_p32 <= y_p31; y_p31 <= y_row3;
                
                cb_p13 <= cb_p12; cb_p12 <= cb_p11; cb_p11 <= cb_row1;
                cb_p23 <= cb_p22; cb_p22 <= cb_p21; cb_p21 <= cb_row2;
                cb_p33 <= cb_p32; cb_p32 <= cb_p31; cb_p31 <= cb_row3;

                cr_p13 <= cr_p12; cr_p12 <= cr_p11; cr_p11 <= cr_row1;
                cr_p23 <= cr_p22; cr_p22 <= cr_p21; cr_p21 <= cr_row2;
                cr_p33 <= cr_p32; cr_p32 <= cr_p31; cr_p31 <= cr_row3;
            end
        end
    end

    // ==========================================
    // 3. 高斯乘加树 (Gaussian MAC) - 流水线计算
    // 高斯权重:
    // [ 1  2  1 ]
    // [ 2  4  2 ]
    // [ 1  2  1 ]
    // ==========================================
    
    // --- 拍数 3：计算每一行的加权和 ---
    reg [9:0] y_sum1, y_sum3, cb_sum1, cb_sum3, cr_sum1, cr_sum3;
    reg [10:0] y_sum2, cb_sum2, cr_sum2;
    reg vs_d3, de_d3;

    always @(posedge pclk or negedge rst_n) begin
        if(!rst_n) begin
            y_sum1 <= 10'd0; y_sum2 <= 11'd0; y_sum3 <= 10'd0;
            cb_sum1 <= 10'd0; cb_sum2 <= 11'd0; cb_sum3 <= 10'd0;
            cr_sum1 <= 10'd0; cr_sum2 <= 11'd0; cr_sum3 <= 10'd0;
            vs_d3 <= 0; de_d3 <= 0;
        end
        else begin
            y_sum1  <= {2'd0, y_p11} + ({2'd0, y_p12} << 1) +
                       {2'd0, y_p13};
            y_sum2  <= ({3'd0, y_p21} << 1) +
                       ({3'd0, y_p22} << 2) +
                       ({3'd0, y_p23} << 1);
            y_sum3  <= {2'd0, y_p31} + ({2'd0, y_p32} << 1) +
                       {2'd0, y_p33};

            cb_sum1 <= {2'd0, cb_p11} + ({2'd0, cb_p12} << 1) +
                       {2'd0, cb_p13};
            cb_sum2 <= ({3'd0, cb_p21} << 1) +
                       ({3'd0, cb_p22} << 2) +
                       ({3'd0, cb_p23} << 1);
            cb_sum3 <= {2'd0, cb_p31} + ({2'd0, cb_p32} << 1) +
                       {2'd0, cb_p33};

            cr_sum1 <= {2'd0, cr_p11} + ({2'd0, cr_p12} << 1) +
                       {2'd0, cr_p13};
            cr_sum2 <= ({3'd0, cr_p21} << 1) +
                       ({3'd0, cr_p22} << 2) +
                       ({3'd0, cr_p23} << 1);
            cr_sum3 <= {2'd0, cr_p31} + ({2'd0, cr_p32} << 1) +
                       {2'd0, cr_p33};

            vs_d3 <= vs_d2; de_d3 <= de_d2;
        end
    end

    // --- 拍数 4：计算总和 ---
    reg [11:0] y_total, cb_total, cr_total;
    reg vs_d4, de_d4;

    always @(posedge pclk or negedge rst_n) begin
        if(!rst_n) begin
            y_total <= 12'd0; cb_total <= 12'd0; cr_total <= 12'd0;
            vs_d4 <= 0; de_d4 <= 0;
        end
        else begin
            y_total  <= {2'd0, y_sum1} + {1'd0, y_sum2} +
                        {2'd0, y_sum3};
            cb_total <= {2'd0, cb_sum1} + {1'd0, cb_sum2} +
                        {2'd0, cb_sum3};
            cr_total <= {2'd0, cr_sum1} + {1'd0, cr_sum2} +
                        {2'd0, cr_sum3};
            vs_d4 <= vs_d3; de_d4 <= de_d3;
        end
    end

    // --- 拍数 5：除以 16 并输出 ---
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_out <= 0; cb_out <= 0; cr_out <= 0;
            vs_out <= 0; de_out <= 0;
        end else begin
            y_out <= (FILTER_LUMA != 0) ? y_total[11:4] : y_bypass_d4;
            if ((BYPASS_BORDER != 0) && !kernel_valid_pipe[3]) begin
                cb_out <= cb_bypass_d4;
                cr_out <= cr_bypass_d4;
            end else begin
                cb_out <= cb_total[11:4];
                cr_out <= cr_total[11:4];
            end
            vs_out <= vs_d4;
            de_out <= de_d4;
        end
    end

endmodule
