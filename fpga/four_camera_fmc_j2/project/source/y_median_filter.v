`timescale 1ns / 1ps

module y_median_filter #(
    parameter IMG_WIDTH = 1280,
    parameter integer BYPASS_BORDER = 0
)(
    input  wire        pclk,
    input  wire        rst_n,
    
    // 输入接口 (连接 RGB2YCbCr 的输出)
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [7:0]  y_in,
    input  wire [7:0]  cb_in,
    input  wire [7:0]  cr_in,
    
    // 输出接口 (连接 YCbCr2RGB 的输入 或 下一个增强模块)
    output reg         vs_out,
    output reg         de_out,
    output reg  [7:0]  y_out,
    output reg  [7:0]  cb_out,
    output reg  [7:0]  cr_out
);

    // ==========================================
    // 1. 同步行缓存 (Line Buffer) - 调用 IP 核
    // ==========================================
    reg  [10:0] wr_ptr;      // 当前像素地址
    reg  [10:0] wr_ptr_d1;   // 延迟1拍的地址 (专门给 RAM2 写数据用)
    reg         vs_d1, de_d1;
    reg  [7:0]  row3_data;   // 延迟1拍的 y_in，用于和 RAM 读出数据对齐
    reg  [10:0] active_x;
    reg  [10:0] active_y;
    reg         de_in_d;
    reg  [3:0]  kernel_valid_pipe;
    reg  [7:0]  y_bypass_d1;
    reg  [7:0]  y_bypass_d2;
    reg  [7:0]  y_bypass_d3;
    reg  [7:0]  y_bypass_d4;
    
    wire [7:0]  row2_data;   // 从 RAM1 读出的历史行
    wire [7:0]  row1_data;   // 从 RAM2 读出的更老的历史行

    // 读写指针生成逻辑
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr    <= 11'd0;
            wr_ptr_d1 <= 11'd0;
            vs_d1 <= 1'b0; de_d1 <= 1'b0;
            row3_data <= 8'd0;
            active_x <= 11'd0;
            active_y <= 11'd0;
            de_in_d <= 1'b0;
            kernel_valid_pipe <= 4'b0000;
            y_bypass_d1 <= 8'd0;
            y_bypass_d2 <= 8'd0;
            y_bypass_d3 <= 8'd0;
            y_bypass_d4 <= 8'd0;
        end else begin
            vs_d1 <= vs_in;
            de_d1 <= de_in;
            de_in_d <= de_in;
            
            if (vs_in) begin
                wr_ptr <= 11'd0; // 场同步到来，指针复位
                active_x <= 11'd0;
                active_y <= 11'd0;
            end else if (de_in) begin
                wr_ptr <= (wr_ptr == IMG_WIDTH - 1) ? 11'd0 : wr_ptr + 1'b1;
                active_x <= (active_x == IMG_WIDTH - 1) ?
                            11'd0 : active_x + 1'b1;
            end
            if (!vs_in && de_in_d && !de_in)
                active_y <= active_y + 1'b1;
            
            // 关键：将指针和使能打拍，因为 RAM 输出数据有 1 拍的延迟
            wr_ptr_d1 <= wr_ptr; 
            row3_data <= y_in;   // 锁存当前行，使其与 row1, row2 在同一时钟沿对齐
            kernel_valid_pipe <= {
                kernel_valid_pipe[2:0],
                de_in && (active_x >= 11'd2) && (active_y >= 11'd2)
            };
            y_bypass_d1 <= y_in;
            y_bypass_d2 <= y_bypass_d1;
            y_bypass_d3 <= y_bypass_d2;
            y_bypass_d4 <= y_bypass_d3;
        end
    end

    // ------------------------------------------
    // 例化 IP 1：保存当前行 y_in，读出上一行 row2_data
    // ------------------------------------------
    line_buf u_line_buf_1 (
        .wr_data ( y_in ),       // input [7:0]
        .wr_addr ( wr_ptr ),     // input [10:0]
        .wr_en   ( de_in ),      // input
        .wr_clk  ( pclk ),       // input
        .wr_rst  ( ~rst_n ),     // input (通常IP核复位是高有效，用 ~rst_n)
        .rd_addr ( wr_ptr ),     // input [10:0]
        .rd_data ( row2_data ),  // output [7:0]
        .rd_clk  ( pclk ),       // input
        .rd_rst  ( ~rst_n )      // input
    );

    // ------------------------------------------
    // 例化 IP 2：保存上一行 row2_data，读出上上行 row1_data
    // ------------------------------------------
    line_buf u_line_buf_2 (
        .wr_data ( row2_data ),  // 存入 RAM1 吐出来的旧数据
        .wr_addr ( wr_ptr_d1 ),  // 重点：此时时间已经过了 1 拍，必须用延迟后的地址写入！
        .wr_en   ( de_d1 ),      // 重点：必须用延迟后的使能信号写入！
        .wr_clk  ( pclk ),       
        .wr_rst  ( ~rst_n ),     
        .rd_addr ( wr_ptr ),     // 读地址依然用当前指针，提前准备好数据
        .rd_data ( row1_data ),  
        .rd_clk  ( pclk ),       
        .rd_rst  ( ~rst_n )      
    );

    // ==========================================
    // 2. 3x3 矩阵窗口生成 - 消耗 1 拍
    // ==========================================
    reg [7:0] p11, p12, p13;
    reg [7:0] p21, p22, p23;
    reg [7:0] p31, p32, p33;
    reg vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {p11, p12, p13} <= 24'd0; {p21, p22, p23} <= 24'd0; {p31, p32, p33} <= 24'd0;
            vs_d2 <= 1'b0; de_d2 <= 1'b0;
        end else begin
            vs_d2 <= vs_d1; de_d2 <= de_d1;
            if (de_d1) begin
                p13 <= p12; p12 <= p11; p11 <= row1_data;
                p23 <= p22; p22 <= p21; p21 <= row2_data;
                p33 <= p32; p32 <= p31; p31 <= row3_data; // 这里的 row3 已经对齐过了
            end
        end
    end

    // ==========================================
    // 3. 快速中值排序网络 - 消耗 3 拍
    // ==========================================
    function [23:0] sort3; 
        input [7:0] d1, d2, d3;
        reg [7:0] max, med, min;
        begin
            if (d1 >= d2 && d1 >= d3) begin max = d1; if (d2 >= d3) begin med = d2; min = d3; end else begin med = d3; min = d2; end end
            else if (d2 >= d1 && d2 >= d3) begin max = d2; if (d1 >= d3) begin med = d1; min = d3; end else begin med = d3; min = d1; end end
            else begin max = d3; if (d1 >= d2) begin med = d1; min = d2; end else begin med = d2; min = d1; end end
            sort3 = {max, med, min};
        end
    endfunction

    // 拍数 3：行内排序
    reg [7:0] max1, med1, min1, max2, med2, min2, max3, med3, min3;
    reg vs_d3, de_d3;
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {max1, med1, min1, max2, med2, min2,
             max3, med3, min3} <= 72'd0;
            vs_d3 <= 1'b0;
            de_d3 <= 1'b0;
        end else begin
            {max1, med1, min1} <= sort3(p11, p12, p13);
            {max2, med2, min2} <= sort3(p21, p22, p23);
            {max3, med3, min3} <= sort3(p31, p32, p33);
            vs_d3 <= vs_d2; de_d3 <= de_d2;
        end
    end

    // 拍数 4：列间交叉提取
    reg [7:0] min_of_max, med_of_med, max_of_min;
    reg vs_d4, de_d4;
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            min_of_max <= 8'd0;
            med_of_med <= 8'd0;
            max_of_min <= 8'd0;
            vs_d4 <= 1'b0;
            de_d4 <= 1'b0;
        end else begin
            min_of_max <= sort3(max1, max2, max3) & 8'hFF;
            med_of_med <= (sort3(med1, med2, med3) >> 8) & 8'hFF;
            max_of_min <= sort3(min1, min2, min3) >> 16;
            vs_d4 <= vs_d3;
            de_d4 <= de_d3;
        end
    end

    // ==========================================
    // 4. 色度通道 (Cb/Cr) 的同步延迟线 (共 4 拍延迟)
    // T0(输入) -> T1(RAM/rowX) -> T2(矩阵) -> T3(行排序) -> T4(列排序) -> T5(直接输出)
    // ==========================================
    reg [7:0] cb_delay [0:3];
    reg [7:0] cr_delay [0:3];

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            cb_delay[0]<=0; cb_delay[1]<=0; cb_delay[2]<=0; cb_delay[3]<=0; 
            cr_delay[0]<=0; cr_delay[1]<=0; cr_delay[2]<=0; cr_delay[3]<=0; 
        end else if (de_in) begin
            cb_delay[0] <= cb_in; 
            cb_delay[1] <= cb_delay[0]; 
            cb_delay[2] <= cb_delay[1]; 
            cb_delay[3] <= cb_delay[2]; 
            
            cr_delay[0] <= cr_in; 
            cr_delay[1] <= cr_delay[0]; 
            cr_delay[2] <= cr_delay[1]; 
            cr_delay[3] <= cr_delay[2]; 
        end
    end

    // ==========================================
    // 5. 最终中值求取与输出 (合并到 1 拍，优化了延迟)
    // ==========================================
    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_out <= 0; cb_out <= 0; cr_out <= 0;
            vs_out <= 0; de_out <= 0;
        end else begin
            // 拍数 5：最后一次排序直接赋值给 y_out，不占用额外寄存器
            if ((BYPASS_BORDER != 0) && !kernel_valid_pipe[3])
                y_out <= y_bypass_d4;
            else
                y_out <= (sort3(min_of_max, med_of_med, max_of_min) >> 8) & 8'hFF;
            cb_out <= cb_delay[3]; 
            cr_out <= cr_delay[3];
            vs_out <= vs_d4;
            de_out <= de_d4;
        end
    end

endmodule
