`timescale 1ns / 1ps

module sfp_dual_link_rx(
    input  wire        clk,
    input  wire        rst,
    input  wire        ch3_rst,
    input  wire        ch4_rst,
    input  wire [31:0] rxd,
    input  wire [3:0]  rxk,

    input  wire        fifo3_full,
    output reg         fifo3_wr_en,
    output reg  [35:0] fifo3_wr_data,

    input  wire        fifo4_full,
    output reg         fifo4_wr_en,
    output reg  [35:0] fifo4_wr_data,

    output wire        rx3_packet_activity,
    output wire        rx4_packet_activity,
    output wire        rx_packet_activity
);
    localparam [31:0] WORD_V_SYNC  = 32'hFFAA55BC;
    localparam [31:0] WORD_H_START = 32'hAA0000BC;
    localparam [31:0] WORD_H_END   = 32'hCC0000BC;
    localparam [15:0] H_DATA_TAG   = 16'h5A5A;
    localparam [11:0] LINE_PIXELS  = 12'd1280;

    wire [7:0] b0 = rxd[7:0];
    wire [7:0] b1 = rxd[15:8];
    wire [7:0] b2 = rxd[23:16];
    wire [7:0] b3 = rxd[31:24];

    reg [1:0] align_idx;
    reg       align_locked;
    reg       prev_valid;
    reg [31:0] rxd_prev;
    reg [3:0]  rxk_prev;
    reg [31:0] rxd_std;
    reg [3:0]  rxk_std;

    wire bc0 = (b0 == 8'hBC) && rxk[0];
    wire bc1 = (b1 == 8'hBC) && rxk[1];
    wire bc2 = (b2 == 8'hBC) && rxk[2];
    wire bc3 = (b3 == 8'hBC) && rxk[3];
    wire bc_found = bc0 | bc1 | bc2 | bc3;
    wire [1:0] bc_idx_w =
        bc0 ? 2'd0 :
        bc1 ? 2'd1 :
        bc2 ? 2'd2 :
        bc3 ? 2'd3 :
              align_idx;

    reg        in_line3;
    reg        in_line4;
    reg [11:0] pixel_cnt3;
    reg [11:0] pixel_cnt4;

    wire alignment_change =
        bc_found && (!align_locked || (bc_idx_w != align_idx));
    wire aligned_word_valid =
        prev_valid && align_locked && !alignment_change;

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

    wire is_ctrl =
        aligned_word_valid && (rxk_std == 4'b0001) &&
        (rxd_std[7:0] == 8'hBC);
    wire [3:0] ctrl_type = rxd_std[31:28];
    wire [3:0] ctrl_channel = rxd_std[27:24];

    wire new_vsync =
        is_ctrl && (ctrl_type == 4'hF) &&
        (rxd_std[23:8] == 16'hAA55);
    wire new_h_start =
        is_ctrl && (ctrl_type == 4'hA) &&
        (rxd_std[23:8] == 16'h0000);
    wire new_h_end =
        is_ctrl && (ctrl_type == 4'hC) &&
        (rxd_std[23:8] == 16'h0000);

    wire legacy_vsync   = is_ctrl && (rxd_std == WORD_V_SYNC);
    wire legacy_h_start = is_ctrl && (rxd_std == WORD_H_START);
    wire legacy_h_end   = is_ctrl && (rxd_std == WORD_H_END);

    wire new_data_raw =
        aligned_word_valid && (rxk_std == 4'b0000) &&
        (rxd_std[31:20] == 12'h5A0);
    wire [3:0] data_channel = rxd_std[19:16];
    wire legacy_data_raw =
        aligned_word_valid && (rxk_std == 4'b0000) &&
        (rxd_std[31:16] == H_DATA_TAG);

    wire ch3_vsync = new_vsync && (ctrl_channel == 4'd3);
    wire ch3_h_start = new_h_start && (ctrl_channel == 4'd3);
    wire ch3_h_end = new_h_end && (ctrl_channel == 4'd3);
    wire ch3_data = new_data_raw && (data_channel == 4'd3) &&
                    in_line3 && (pixel_cnt3 < LINE_PIXELS);

    wire ch4_vsync = legacy_vsync ||
                     (new_vsync && (ctrl_channel == 4'd4));
    wire ch4_h_start = legacy_h_start ||
                       (new_h_start && (ctrl_channel == 4'd4));
    wire ch4_h_end = legacy_h_end ||
                     (new_h_end && (ctrl_channel == 4'd4));
    wire ch4_data = ((new_data_raw && (data_channel == 4'd4)) ||
                     legacy_data_raw) &&
                    in_line4 && (pixel_cnt4 < LINE_PIXELS);

    // These pulses are independent of FIFO full so each channel watchdog
    // measures valid protocol traffic rather than downstream backpressure.
    assign rx3_packet_activity = !rst && !ch3_rst &&
        (ch3_vsync | ch3_h_start | ch3_h_end | ch3_data);
    assign rx4_packet_activity = !rst && !ch4_rst &&
        (ch4_vsync | ch4_h_start | ch4_h_end | ch4_data);
    assign rx_packet_activity = rx3_packet_activity | rx4_packet_activity;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            align_idx    <= 2'd0;
            align_locked <= 1'b0;
            prev_valid   <= 1'b0;
            rxd_prev     <= 32'd0;
            rxk_prev     <= 4'd0;
        end else begin
            rxd_prev   <= rxd;
            rxk_prev   <= rxk;
            prev_valid <= 1'b1;

            if (bc_found) begin
                align_idx    <= bc_idx_w;
                align_locked <= 1'b1;
            end
        end
    end

    wire ch3_state_rst = rst | ch3_rst;
    wire ch4_state_rst = rst | ch4_rst;

    always @(posedge clk or posedge ch3_state_rst) begin
        if (ch3_state_rst) begin
            in_line3   <= 1'b0;
            pixel_cnt3 <= 12'd0;
        end else if (alignment_change) begin
            in_line3   <= 1'b0;
            pixel_cnt3 <= 12'd0;
        end else if (ch3_vsync) begin
            in_line3   <= 1'b0;
            pixel_cnt3 <= 12'd0;
        end else if (ch3_h_start) begin
            in_line3   <= 1'b1;
            pixel_cnt3 <= 12'd0;
        end else if (ch3_h_end) begin
            in_line3   <= 1'b0;
            pixel_cnt3 <= 12'd0;
        end else if (ch3_data) begin
            pixel_cnt3 <= pixel_cnt3 + 1'b1;
        end
    end

    always @(posedge clk or posedge ch4_state_rst) begin
        if (ch4_state_rst) begin
            in_line4   <= 1'b0;
            pixel_cnt4 <= 12'd0;
        end else if (alignment_change) begin
            in_line4   <= 1'b0;
            pixel_cnt4 <= 12'd0;
        end else if (ch4_vsync) begin
            in_line4   <= 1'b0;
            pixel_cnt4 <= 12'd0;
        end else if (ch4_h_start) begin
            in_line4   <= 1'b1;
            pixel_cnt4 <= 12'd0;
        end else if (ch4_h_end) begin
            in_line4   <= 1'b0;
            pixel_cnt4 <= 12'd0;
        end else if (ch4_data) begin
            pixel_cnt4 <= pixel_cnt4 + 1'b1;
        end
    end

    always @(posedge clk or posedge ch3_state_rst) begin
        if (ch3_state_rst) begin
            fifo3_wr_en   <= 1'b0;
            fifo3_wr_data <= 36'd0;
        end else begin
            fifo3_wr_en <= 1'b0;

            if (!fifo3_full) begin
                if (ch3_vsync) begin
                    fifo3_wr_en   <= 1'b1;
                    fifo3_wr_data <= {4'b0001, WORD_V_SYNC};
                end else if (ch3_h_start) begin
                    fifo3_wr_en   <= 1'b1;
                    fifo3_wr_data <= {4'b0001, WORD_H_START};
                end else if (ch3_h_end) begin
                    fifo3_wr_en   <= 1'b1;
                    fifo3_wr_data <= {4'b0001, WORD_H_END};
                end else if (ch3_data) begin
                    fifo3_wr_en   <= 1'b1;
                    fifo3_wr_data <= {4'b0000, H_DATA_TAG, rxd_std[15:0]};
                end
            end
        end
    end

    always @(posedge clk or posedge ch4_state_rst) begin
        if (ch4_state_rst) begin
            fifo4_wr_en   <= 1'b0;
            fifo4_wr_data <= 36'd0;
        end else begin
            fifo4_wr_en <= 1'b0;
            if (!fifo4_full) begin
                if (ch4_vsync) begin
                    fifo4_wr_en   <= 1'b1;
                    fifo4_wr_data <= {4'b0001, WORD_V_SYNC};
                end else if (ch4_h_start) begin
                    fifo4_wr_en   <= 1'b1;
                    fifo4_wr_data <= {4'b0001, WORD_H_START};
                end else if (ch4_h_end) begin
                    fifo4_wr_en   <= 1'b1;
                    fifo4_wr_data <= {4'b0001, WORD_H_END};
                end else if (ch4_data) begin
                    fifo4_wr_en   <= 1'b1;
                    fifo4_wr_data <= {4'b0000, H_DATA_TAG, rxd_std[15:0]};
                end
            end
        end
    end
endmodule
