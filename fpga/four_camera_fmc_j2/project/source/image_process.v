`timescale 1ns / 1ps

module image_process (
    input  wire        pclk, 
    input  wire        rst_n,
    input  wire        vs_in, 
    input  wire        de_in,
    input  wire [15:0] data_in,
    
    output wire        vs_out, 
    output wire        de_out,
    output wire [15:0] data_out
);

    // ==========================================
    // 内部连接线声明 (Pipeline Wires)
    // ==========================================
    
    // 连线 1：[RGB转YCbCr] -> [中值滤波]
    wire        vs_mid1, de_mid1;
    wire [7:0]  y_mid1, cb_mid1, cr_mid1;

    // 连线 2：[中值滤波] -> [高斯滤波]
    wire        vs_mid2, de_mid2;
    wire [7:0]  y_mid2, cb_mid2, cr_mid2;

    // 连线 3：[高斯滤波] -> [YCbCr转RGB]
    wire        vs_mid3, de_mid3;
    wire [7:0]  y_mid3, cb_mid3, cr_mid3;


    // ------------------------------------------
    // 积木 1：正向变换 (RGB565 -> YCbCr)
    // ------------------------------------------
    rgb2ycbcr u_rgb2ycbcr (
        .pclk       (pclk),
        .rst_n      (rst_n),
        .vs_in      (vs_in),
        .de_in      (de_in),
        .rgb_in     (data_in),
        
        // 输出到中段连接线 1
        .vs_out     (vs_mid1),
        .de_out     (de_mid1),
        .y_out      (y_mid1),
        .cb_out     (cb_mid1),
        .cr_out     (cr_mid1)
    );

    // ------------------------------------------
    // 积木 2：Y 通道中值滤波 (吃 mid1，吐 mid2)
    // 专门对付死像素/热噪点 (DPC 坏点校正)
    // ------------------------------------------
    y_median_filter #( .IMG_WIDTH(1280) ) u_y_median_filter (
        .pclk       (pclk), 
        .rst_n      (rst_n),
        
        // 接收中段连接线 1
        .vs_in      (vs_mid1), 
        .de_in      (de_mid1),
        .y_in       (y_mid1), 
        .cb_in      (cb_mid1), 
        .cr_in      (cr_mid1),
        
        // 输出到中段连接线 2
        .vs_out     (vs_mid2), 
        .de_out     (de_mid2),
        .y_out      (y_mid2), 
        .cb_out     (cb_mid2), 
        .cr_out     (cr_mid2)
    );

    // ------------------------------------------
    // 积木 3：Y 通道高斯滤波 (吃 mid2，吐 mid3)
    // 专门对付增益带来的底噪，让画面更顺滑 (2D-DNR)
    // ------------------------------------------
    y_gaussian_filter #( .IMG_WIDTH(1280) ) u_y_gaussian_filter (
        .pclk       (pclk), 
        .rst_n      (rst_n),
        
        // 接收中段连接线 2
        .vs_in      (vs_mid2), 
        .de_in      (de_mid2),
        .y_in       (y_mid2), 
        .cb_in      (cb_mid2), 
        .cr_in      (cr_mid2),
        
        // 输出到中段连接线 3
        .vs_out     (vs_mid3), 
        .de_out     (de_mid3),
        .y_out      (y_mid3), 
        .cb_out     (cb_mid3), 
        .cr_out     (cr_mid3)
    );

    // ------------------------------------------
    // 积木 4：逆向变换 (YCbCr -> RGB565)
    // ------------------------------------------
    ycbcr2rgb u_ycbcr2rgb (
        .pclk       (pclk),
        .rst_n      (rst_n),
        
        // 接收中段连接线 3 (高斯滤波吐出来的数据)
        .vs_in      (vs_mid3),
        .de_in      (de_mid3),
        .y_in       (y_mid3),
        .cb_in      (cb_mid3),
        .cr_in      (cr_mid3),
        
        // 输出到顶层接口，送往显示器
        .vs_out     (vs_out),    
        .de_out     (de_out),
        .rgb_out    (data_out)
    );

endmodule