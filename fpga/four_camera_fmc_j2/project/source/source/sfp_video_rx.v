`timescale 1ns / 1ps
`define UD #1

module sfp_video_rx (
    input  wire        pixclk,
    input  wire        rst,
    input  wire        en,
    input  wire        fifo_empty,
    output wire        fifo_rd_en,
    input  wire [35:0] fifo_rd_data,
    output reg         vs,
    output reg         hs,
    output reg         de,
    output reg  [7:0]  r,
    output reg  [7:0]  g,
    output reg  [7:0]  b,
    output wire [35:0] dbg_word,
    output wire [7:0]  dbg_ctrl,
    output wire [15:0] dbg_rgb565
);
    localparam [31:0] WORD_V_SYNC  = 32'hFFAA55BC;
    localparam [31:0] WORD_H_START = 32'hAA0000BC;
    localparam [31:0] WORD_H_END   = 32'hCC0000BC;
    localparam [15:0] H_DATA_TAG   = 16'h5A5A;
    localparam [11:0] LINE_PIXELS  = 12'd1280;

    reg       rd_data_valid;
    reg [35:0] word_reg /*synthesis PAP_MARK_DEBUG="true"*/;
    reg        in_line;
    reg [11:0] pixel_cnt;

    wire [3:0]  word_k;
    wire [31:0] data;
    wire [15:0] rgb565/*synthesis PAP_MARK_DEBUG="true"*/;
    wire        is_vsync;
    wire        is_h_start;
    wire        is_h_end;
    wire        is_h_data_raw;
    wire        is_h_data;

    assign word_k = fifo_rd_data[35:32];
    assign data   = fifo_rd_data[31:0];
    assign rgb565 = data[15:0];

    assign is_vsync   = (word_k == 4'b0001) && (data == WORD_V_SYNC);
    assign is_h_start = (word_k == 4'b0001) && (data == WORD_H_START);
    assign is_h_end   = (word_k == 4'b0001) && (data == WORD_H_END);
    assign is_h_data_raw = (word_k == 4'b0000) && (data[31:16] == H_DATA_TAG);
    assign is_h_data     = is_h_data_raw && in_line && (pixel_cnt < LINE_PIXELS);

    assign dbg_word   = word_reg;
    assign dbg_ctrl   = word_reg[31:24];
    assign dbg_rgb565 = word_reg[15:0];
    assign fifo_rd_en = en && !fifo_empty;

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            rd_data_valid <= 1'b0;
            word_reg      <= 36'd0;
        end else begin
            rd_data_valid <= fifo_rd_en;
            if (rd_data_valid) begin
                word_reg <= fifo_rd_data;
            end
        end
    end

    always @(posedge pixclk or posedge rst) begin
        if (rst) begin
            vs <= 1'b0;
            hs <= 1'b0;
            de <= 1'b0;
            in_line <= 1'b0;
            pixel_cnt <= 12'd0;
            r  <= 8'd0;
            g  <= 8'd0;
            b  <= 8'd0;
        end else if (!en) begin
            vs <= 1'b0;
            hs <= 1'b0;
            de <= 1'b0;
            in_line <= 1'b0;
            pixel_cnt <= 12'd0;
            r  <= 8'd0;
            g  <= 8'd0;
            b  <= 8'd0;
        end else if (rd_data_valid) begin
            vs <= is_vsync;
            de <= is_h_data;

            if (is_vsync) begin
                hs <= 1'b0;
                in_line <= 1'b0;
                pixel_cnt <= 12'd0;
            end else if (is_h_start) begin
                hs <= 1'b1;
                in_line <= 1'b1;
                pixel_cnt <= 12'd0;
            end else if (is_h_end) begin
                hs <= 1'b0;
                in_line <= 1'b0;
                pixel_cnt <= 12'd0;
            end else if (is_h_data) begin
                pixel_cnt <= pixel_cnt + 1'b1;
            end

            if (is_h_data) begin
                r <= {rgb565[15:11], rgb565[15:13]};
                g <= {rgb565[10:5],  rgb565[10:9]};
                b <= {rgb565[4:0],   rgb565[4:2]};
            end
        end else begin
            vs <= 1'b0;
            de <= 1'b0;
        end
    end
endmodule
