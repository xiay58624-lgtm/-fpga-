`timescale 1ns / 1ps
`define UD #1

module sfp_link_rx (
    input  wire        clk,
    input  wire        rst,
    input  wire [31:0] rxd,
    input  wire [3:0]  rxk,
    input  wire        fifo_full,
    output reg         fifo_wr_en,
    output reg  [35:0] fifo_wr_data
);
    localparam [31:0] WORD_IDLE    = 32'h000000BC;
    localparam [31:0] WORD_V_SYNC  = 32'hFFAA55BC;
    localparam [31:0] WORD_H_START = 32'hAA0000BC;
    localparam [31:0] WORD_H_END   = 32'hCC0000BC;
    localparam [15:0] H_DATA_TAG   = 16'h5A5A;
    localparam [11:0] LINE_PIXELS  = 12'd1280;

    wire [7:0] b0;
    wire [7:0] b1;
    wire [7:0] b2;
    wire [7:0] b3;

    wire       bc0;
    wire       bc1;
    wire       bc2;
    wire       bc3;
    wire       bc_found;
    wire [1:0] bc_idx_w;

    reg  [1:0] align_idx;
    reg        align_locked;
    reg        prev_valid;
    reg        in_line;
    reg [11:0] pixel_cnt;
    reg [31:0] rxd_prev;
    reg [3:0]  rxk_prev;

    reg [31:0] rxd_std;
    reg [3:0]  rxk_std;

    wire       alignment_change;
    wire       aligned_word_valid;

    wire       is_ctrl;
    wire       is_idle;
    wire       is_vsync;
    wire       is_h_start;
    wire       is_h_end;
    wire       is_h_data_raw;
    wire       is_h_data;

    assign b0 = rxd[7:0];
    assign b1 = rxd[15:8];
    assign b2 = rxd[23:16];
    assign b3 = rxd[31:24];

    assign bc0 = (b0 == 8'hBC) && rxk[0];
    assign bc1 = (b1 == 8'hBC) && rxk[1];
    assign bc2 = (b2 == 8'hBC) && rxk[2];
    assign bc3 = (b3 == 8'hBC) && rxk[3];
    assign bc_found = bc0 | bc1 | bc2 | bc3;

    assign bc_idx_w =
        bc0 ? 2'd0 :
        bc1 ? 2'd1 :
        bc2 ? 2'd2 :
        bc3 ? 2'd3 :
              align_idx;

    assign alignment_change = bc_found && (!align_locked || (bc_idx_w != align_idx));
    assign aligned_word_valid = prev_valid && align_locked && !alignment_change;

    // A protocol word can straddle two consecutive 32-bit RX words.
    always @(*) begin
        case (align_idx)
            2'd0: begin
                rxd_std = rxd_prev;
                rxk_std = rxk_prev;
            end
            2'd1: begin
                rxd_std = {rxd[7:0], rxd_prev[31:8]};
                rxk_std = {rxk[0], rxk_prev[3:1]};
            end
            2'd2: begin
                rxd_std = {rxd[15:0], rxd_prev[31:16]};
                rxk_std = {rxk[1:0], rxk_prev[3:2]};
            end
            default: begin
                rxd_std = {rxd[23:0], rxd_prev[31:24]};
                rxk_std = {rxk[2:0], rxk_prev[3]};
            end
        endcase
    end

    assign is_ctrl    = aligned_word_valid && (rxk_std == 4'b0001) && (rxd_std[7:0] == 8'hBC);
    assign is_idle    = is_ctrl && (rxd_std == WORD_IDLE);
    assign is_vsync   = is_ctrl && (rxd_std == WORD_V_SYNC);
    assign is_h_start = is_ctrl && (rxd_std == WORD_H_START);
    assign is_h_end   = is_ctrl && (rxd_std == WORD_H_END);
    assign is_h_data_raw = aligned_word_valid && (rxk_std == 4'b0000) && in_line && (rxd_std[31:16] == H_DATA_TAG);
    assign is_h_data     = is_h_data_raw && (pixel_cnt < LINE_PIXELS);

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            align_idx    <= 2'd0;
            align_locked <= 1'b0;
            prev_valid   <= 1'b0;
            in_line      <= 1'b0;
            pixel_cnt    <= 12'd0;
            rxd_prev     <= 32'd0;
            rxk_prev     <= 4'd0;
            fifo_wr_en   <= 1'b0;
            fifo_wr_data <= 36'd0;
        end else begin
            fifo_wr_en <= 1'b0;
            rxd_prev   <= rxd;
            rxk_prev   <= rxk;
            prev_valid <= 1'b1;

            if (bc_found) begin
                align_idx    <= bc_idx_w;
                align_locked <= 1'b1;
            end

            if (alignment_change) begin
                in_line   <= 1'b0;
                pixel_cnt <= 12'd0;
            end else if (is_vsync) begin
                in_line <= 1'b0;
                pixel_cnt <= 12'd0;
            end else if (is_h_start) begin
                in_line <= 1'b1;
                pixel_cnt <= 12'd0;
            end else if (is_h_end) begin
                in_line <= 1'b0;
                pixel_cnt <= 12'd0;
            end else if (is_h_data) begin
                pixel_cnt <= pixel_cnt + 1'b1;
            end

            if (!fifo_full && (is_vsync || is_h_start || is_h_end || is_h_data) && !is_idle) begin
                fifo_wr_en   <= 1'b1;
                fifo_wr_data <= {rxk_std, rxd_std};
            end
        end
    end
endmodule
