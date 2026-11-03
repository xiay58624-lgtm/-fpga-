`timescale 1ns / 1ps

// CMOS image processing path with frame-level adaptive luma control.
// Video samples stay in the CMOS pixel clock domain. Only the slow control
// state crosses to clk_75m, so VS/DE timing is not exposed to a CDC boundary.
module image_process_adaptive #(
    parameter [9:0] WB_R_GAIN_Q8 = 10'd256,
    parameter [9:0] WB_G_GAIN_Q8 = 10'd256,
    parameter [9:0] WB_B_GAIN_Q8 = 10'd256,
    parameter integer EXPOSURE_AWARE = 1,
    parameter integer ENABLE_AUTO_CHROMA = 1,
    parameter integer BACKLIGHT_COMPENSATION = 1
)(
    input  wire        pclk,
    input  wire        ctrl_clk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [15:0] data_in,
    output wire        vs_out,
    output wire        de_out,
    output wire [15:0] data_out
);

    wire        vs_balanced;
    wire        de_balanced;
    wire [15:0] rgb_balanced;

    wire        vs_ycbcr;
    wire        de_ycbcr;
    wire [7:0]  y_ycbcr;
    wire [7:0]  cb_ycbcr;
    wire [7:0]  cr_ycbcr;

    wire        vs_chroma;
    wire        de_chroma;
    wire [7:0]  y_chroma;
    wire [7:0]  cb_chroma;
    wire [7:0]  cr_chroma;

    wire        vs_median;
    wire        de_median;
    wire [7:0]  y_median;
    wire [7:0]  cb_median;
    wire [7:0]  cr_median;

    wire        vs_gaussian;
    wire        de_gaussian;
    wire [7:0]  y_gaussian;
    wire [7:0]  cb_gaussian;
    wire [7:0]  cr_gaussian;

    wire        vs_luma;
    wire        de_luma;
    wire [7:0]  y_luma;
    wire [7:0]  cb_luma;
    wire [7:0]  cr_luma;

    rgb565_white_balance #(
        .R_GAIN_Q8(WB_R_GAIN_Q8),
        .G_GAIN_Q8(WB_G_GAIN_Q8),
        .B_GAIN_Q8(WB_B_GAIN_Q8)
    ) u_rgb565_white_balance (
        .pclk       (pclk),
        .rst_n      (rst_n),
        .vs_in      (vs_in),
        .de_in      (de_in),
        .rgb_in     (data_in),
        .vs_out     (vs_balanced),
        .de_out     (de_balanced),
        .rgb_out    (rgb_balanced)
    );

    rgb2ycbcr u_rgb2ycbcr (
        .pclk       (pclk),
        .rst_n      (rst_n),
        .vs_in      (vs_balanced),
        .de_in      (de_balanced),
        .rgb_in     (rgb_balanced),
        .vs_out     (vs_ycbcr),
        .de_out     (de_ycbcr),
        .y_out      (y_ycbcr),
        .cb_out     (cb_ycbcr),
        .cr_out     (cr_ycbcr)
    );

    generate
        if (ENABLE_AUTO_CHROMA != 0) begin : g_auto_chroma
            adaptive_chroma_balance u_adaptive_chroma_balance (
                .pclk       (pclk),
                .rst_n      (rst_n),
                .vs_in      (vs_ycbcr),
                .de_in      (de_ycbcr),
                .y_in       (y_ycbcr),
                .cb_in      (cb_ycbcr),
                .cr_in      (cr_ycbcr),
                .vs_out     (vs_chroma),
                .de_out     (de_chroma),
                .y_out      (y_chroma),
                .cb_out     (cb_chroma),
                .cr_out     (cr_chroma)
            );
        end else begin : g_auto_chroma_bypass
            assign vs_chroma = vs_ycbcr;
            assign de_chroma = de_ycbcr;
            assign y_chroma  = y_ycbcr;
            assign cb_chroma = cb_ycbcr;
            assign cr_chroma = cr_ycbcr;
        end
    endgenerate

    y_median_filter #(.IMG_WIDTH(1280)) u_y_median_filter (
        .pclk       (pclk),
        .rst_n      (rst_n),
        .vs_in      (vs_chroma),
        .de_in      (de_chroma),
        .y_in       (y_chroma),
        .cb_in      (cb_chroma),
        .cr_in      (cr_chroma),
        .vs_out     (vs_median),
        .de_out     (de_median),
        .y_out      (y_median),
        .cb_out     (cb_median),
        .cr_out     (cr_median)
    );

    y_gaussian_filter #(.IMG_WIDTH(1280)) u_y_gaussian_filter (
        .pclk       (pclk),
        .rst_n      (rst_n),
        .vs_in      (vs_median),
        .de_in      (de_median),
        .y_in       (y_median),
        .cb_in      (cb_median),
        .cr_in      (cr_median),
        .vs_out     (vs_gaussian),
        .de_out     (de_gaussian),
        .y_out      (y_gaussian),
        .cb_out     (cb_gaussian),
        .cr_out     (cr_gaussian)
    );

    adaptive_luma_cdc #(
        .EXPOSURE_AWARE(EXPOSURE_AWARE),
        .BACKLIGHT_COMPENSATION(BACKLIGHT_COMPENSATION)
    ) u_adaptive_luma_cdc (
        .pclk       (pclk),
        .ctrl_clk   (ctrl_clk),
        .rst_n      (rst_n),
        .vs_in      (vs_gaussian),
        .de_in      (de_gaussian),
        .y_in       (y_gaussian),
        .cb_in      (cb_gaussian),
        .cr_in      (cr_gaussian),
        .vs_out     (vs_luma),
        .de_out     (de_luma),
        .y_out      (y_luma),
        .cb_out     (cb_luma),
        .cr_out     (cr_luma)
    );

    ycbcr2rgb u_ycbcr2rgb (
        .pclk       (pclk),
        .rst_n      (rst_n),
        .vs_in      (vs_luma),
        .de_in      (de_luma),
        .y_in       (y_luma),
        .cb_in      (cb_luma),
        .cr_in      (cr_luma),
        .vs_out     (vs_out),
        .de_out     (de_out),
        .rgb_out    (data_out)
    );

endmodule

// Camera ISP used directly by the two OV5640 inputs. A shared causal window
// provides conditional impulse/chroma cleanup, while frame statistics drive
// bounded tone mapping and detail enhancement without unconditional blur.
module camera_isp_scurve #(
    parameter integer IMG_WIDTH = 1280,
    parameter integer MIN_FRAME_PIXELS = 800000,
    parameter integer IMPULSE_THRESHOLD = 24,
    parameter integer CHROMA_EDGE_THRESHOLD = 48,
    parameter integer TONE_STRENGTH_MAX_Q8 = 128,
    parameter integer LOCAL_DRC_ENABLE = 1,
    parameter integer DETAIL_ENABLE = 1
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [15:0] data_in,
    output wire        vs_out,
    output wire        de_out,
    output wire [15:0] data_out
);
    // rgb2ycbcr uses the legacy low-bit R convention internally.
    wire [15:0] converter_rgb565 = {
        data_in[4:0], data_in[10:5], data_in[15:11]
    };

    wire       vs_ycbcr;
    wire       de_ycbcr;
    wire [7:0] y_ycbcr;
    wire [7:0] cb_ycbcr;
    wire [7:0] cr_ycbcr;
    wire       vs_features;
    wire       de_features;
    wire [7:0] center_y;
    wire [7:0] center_cb;
    wire [7:0] center_cr;
    wire [7:0] median_y;
    wire [7:0] gaussian_y;
    wire [7:0] gaussian_cb;
    wire [7:0] gaussian_cr;
    wire [7:0] min_y;
    wire [7:0] max_y;
    wire       kernel_valid;

    wire       vs_spatial;
    wire       de_spatial;
    wire [7:0] y_spatial;
    wire [7:0] cb_spatial;
    wire [7:0] cr_spatial;
    wire [7:0] blur_spatial;
    wire       kernel_spatial;

    wire [2:0] scene_mode;
    wire [8:0] tone_strength_q8;
    wire       stats_valid;
    wire [7:0] stats_p05;
    wire [7:0] stats_p10;
    wire [7:0] stats_p50;
    wire [7:0] stats_p95;
    wire [19:0] stats_total;
    wire [19:0] stats_dark;
    wire [19:0] stats_shadow;
    wire [19:0] stats_highlight;
    wire [19:0] stats_near_clip;
    wire [19:0] stats_clip;
    wire       grid_gain_valid;
    wire [7:0] grid_gain_addr;
    wire [8:0] grid_gain_q8;
    wire       grid_table_done;

    wire       vs_tone;
    wire       de_tone;
    wire [7:0] y_tone;
    wire [7:0] cb_tone;
    wire [7:0] cr_tone;
    wire [7:0] detail_center_tone;
    wire [7:0] detail_blur_tone;
    wire       detail_kernel_tone;

    wire       vs_local;
    wire       de_local;
    wire [7:0] y_local;
    wire [7:0] cb_local;
    wire [7:0] cr_local;
    wire [7:0] detail_center_local;
    wire [7:0] detail_blur_local;
    wire       detail_kernel_local;

    wire       vs_detail;
    wire       de_detail;
    wire [7:0] y_detail;
    wire [7:0] cb_detail;
    wire [7:0] cr_detail;

    rgb2ycbcr u_camera_isp_rgb2ycbcr (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_in), .de_in(de_in), .rgb_in(converter_rgb565),
        .vs_out(vs_ycbcr), .de_out(de_ycbcr),
        .y_out(y_ycbcr), .cb_out(cb_ycbcr), .cr_out(cr_ycbcr)
    );

    // Statistics are taken from the unmodified Y stream. Parameters produced
    // from one complete frame become active only at a later frame boundary.
    isp_luma_histogram_32 #(
        .MIN_FRAME_SAMPLES((MIN_FRAME_PIXELS < 16) ? 1 :
                           (MIN_FRAME_PIXELS / 16))
    ) u_camera_histogram (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_ycbcr), .de_in(de_ycbcr),
        .y_in(y_ycbcr), .cb_in(cb_ycbcr), .cr_in(cr_ycbcr),
        .stats_valid(stats_valid),
        .p05(stats_p05), .p10(stats_p10),
        .p50(stats_p50), .p95(stats_p95),
        .sample_total(stats_total),
        .dark_count(stats_dark), .shadow_count(stats_shadow),
        .highlight_count(stats_highlight),
        .near_clip_count(stats_near_clip), .clip_count(stats_clip)
    );

    isp_grid_stats_16x9 #(
        .CELL_WIDTH(80),
        .CELL_HEIGHT(80),
        .MIN_CELL_SAMPLES(6000)
    ) u_camera_grid_stats (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_ycbcr), .de_in(de_ycbcr), .y_in(y_ycbcr),
        .raw_gain_valid(grid_gain_valid),
        .raw_gain_addr(grid_gain_addr),
        .raw_gain_q8(grid_gain_q8),
        .raw_table_done(grid_table_done)
    );

    isp_scene_controller #(
        .MAX_STRENGTH_Q8(TONE_STRENGTH_MAX_Q8),
        .CONFIRM_FRAMES(6)
    ) u_camera_scene_controller (
        .pclk(pclk), .rst_n(rst_n),
        .stats_valid(stats_valid),
        .p05(stats_p05), .p10(stats_p10),
        .p50(stats_p50), .p95(stats_p95),
        .sample_total(stats_total),
        .dark_count(stats_dark), .shadow_count(stats_shadow),
        .highlight_count(stats_highlight),
        .near_clip_count(stats_near_clip), .clip_count(stats_clip),
        .scene_mode(scene_mode), .strength_q8(tone_strength_q8)
    );

    // One set of line buffers supplies all spatial candidates. Y is never
    // unconditionally replaced by either the median or Gaussian result.
    isp_3x3_features #(
        .IMG_WIDTH(IMG_WIDTH)
    ) u_camera_features (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_ycbcr), .de_in(de_ycbcr),
        .y_in(y_ycbcr), .cb_in(cb_ycbcr), .cr_in(cr_ycbcr),
        .vs_out(vs_features), .de_out(de_features),
        .center_y(center_y), .center_cb(center_cb), .center_cr(center_cr),
        .median_y(median_y), .gaussian_y(gaussian_y),
        .gaussian_cb(gaussian_cb), .gaussian_cr(gaussian_cr),
        .min_y(min_y), .max_y(max_y), .kernel_valid(kernel_valid)
    );

    isp_camera_spatial_filter #(
        .IMPULSE_THRESHOLD(IMPULSE_THRESHOLD),
        .CHROMA_EDGE_THRESHOLD(CHROMA_EDGE_THRESHOLD)
    ) u_camera_spatial_filter (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_features), .de_in(de_features),
        .center_y(center_y), .center_cb(center_cb), .center_cr(center_cr),
        .median_y(median_y), .gaussian_y(gaussian_y),
        .gaussian_cb(gaussian_cb), .gaussian_cr(gaussian_cr),
        .min_y(min_y), .max_y(max_y), .kernel_valid(kernel_valid),
        .vs_out(vs_spatial), .de_out(de_spatial),
        .y_out(y_spatial), .cb_out(cb_spatial), .cr_out(cr_spatial),
        .blur_y_out(blur_spatial), .kernel_valid_out(kernel_spatial)
    );

    isp_tone_mapper_17pt u_camera_tone_mapper (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_spatial), .de_in(de_spatial),
        .y_in(y_spatial), .cb_in(cb_spatial), .cr_in(cr_spatial),
        .detail_center_in(y_spatial), .detail_blur_in(blur_spatial),
        .kernel_valid_in(kernel_spatial),
        .scene_mode(scene_mode), .strength_q8(tone_strength_q8),
        .vs_out(vs_tone), .de_out(de_tone),
        .y_out(y_tone), .cb_out(cb_tone), .cr_out(cr_tone),
        .detail_center_out(detail_center_tone),
        .detail_blur_out(detail_blur_tone),
        .kernel_valid_out(detail_kernel_tone)
    );

    isp_local_drc_16x9 #(
        .ENABLE(LOCAL_DRC_ENABLE),
        .CELL_WIDTH(80), .CELL_HEIGHT(80),
        .GAIN_MIN_Q8(192), .GAIN_MAX_Q8(384),
        .NEIGHBOR_STEP_Q8(32)
    ) u_camera_local_drc (
        .pclk(pclk), .rst_n(rst_n),
        .raw_gain_valid(grid_gain_valid),
        .raw_gain_addr(grid_gain_addr),
        .raw_gain_q8(grid_gain_q8),
        .raw_table_done(grid_table_done),
        .vs_in(vs_tone), .de_in(de_tone),
        .y_in(y_tone), .cb_in(cb_tone), .cr_in(cr_tone),
        .detail_center_in(detail_center_tone),
        .detail_blur_in(detail_blur_tone),
        .kernel_valid_in(detail_kernel_tone),
        .vs_out(vs_local), .de_out(de_local),
        .y_out(y_local), .cb_out(cb_local), .cr_out(cr_local),
        .detail_center_out(detail_center_local),
        .detail_blur_out(detail_blur_local),
        .kernel_valid_out(detail_kernel_local)
    );

    isp_detail_enhance #(
        .ENABLE(DETAIL_ENABLE),
        .NOISE_GATE(5), .LIMIT_POS(8), .LIMIT_NEG(12)
    ) u_camera_detail_enhance (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_local), .de_in(de_local),
        .y_in(y_local), .cb_in(cb_local), .cr_in(cr_local),
        .center_y(detail_center_local), .blur_y(detail_blur_local),
        .kernel_valid(detail_kernel_local),
        .vs_out(vs_detail), .de_out(de_detail),
        .y_out(y_detail), .cb_out(cb_detail), .cr_out(cr_detail)
    );

    ycbcr2rgb u_camera_isp_ycbcr2rgb (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_detail), .de_in(de_detail),
        .y_in(y_detail), .cb_in(cb_detail), .cr_in(cr_detail),
        .vs_out(vs_out), .de_out(de_out), .rgb_out(data_out)
    );
endmodule

// The 1280x720 camera frame is divided into 16x9 cells. Only one row band's
// 16 accumulators are live at a time; the completed 144-entry target table is
// streamed during vertical blanking. An incomplete frame is never published.
module isp_grid_stats_16x9 #(
    parameter integer CELL_WIDTH = 80,
    parameter integer CELL_HEIGHT = 80,
    parameter integer MIN_CELL_SAMPLES = 6000
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    output reg        raw_gain_valid,
    output reg  [7:0] raw_gain_addr,
    output reg  [8:0] raw_gain_q8,
    output reg        raw_table_done
);
    localparam integer GRID_COLS = 16;
    localparam integer GRID_ROWS = 9;
    localparam integer TOTAL_CELLS = GRID_COLS * GRID_ROWS;
    localparam integer FRAME_WIDTH = GRID_COLS * CELL_WIDTH;

    reg [20:0] y_sum [0:GRID_COLS-1];
    reg [12:0] sample_count [0:GRID_COLS-1];
    reg [12:0] dark_count [0:GRID_COLS-1];
    reg [12:0] highlight_count [0:GRID_COLS-1];
    reg [8:0] raw_gain_table [0:TOTAL_CELLS-1];

    reg       vs_d;
    reg       de_d;
    reg [3:0] cell_x;
    reg [7:0] x_in_cell;
    reg [10:0] line_pixel_count;
    reg [7:0] row_in_cell;
    reg [3:0] band_index;
    reg [3:0] completed_bands;
    reg       frame_bad;

    reg       finalize_busy;
    reg [3:0] finalize_index;
    reg [3:0] finalize_band;

    reg       emit_busy;
    reg       emit_done_pending;
    reg [7:0] emit_index;

    integer i;

    wire frame_start = vs_in && !vs_d;
    wire line_end = de_d && !de_in;

    function [8:0] target_gain_q8;
        input [20:0] sum_y;
        input [12:0] count_y;
        input [12:0] count_dark;
        input [12:0] count_highlight;
        reg [20:0] count_w;
        reg [20:0] limit_24;
        reg [20:0] limit_48;
        reg [20:0] limit_72;
        reg [20:0] limit_96;
        reg [20:0] limit_184;
        reg [20:0] limit_208;
        reg [15:0] dark_x4;
        reg [15:0] count_x3;
        reg [15:0] highlight_x8;
        begin
            count_w = {8'd0, count_y};
            limit_24 = (count_w << 4) + (count_w << 3);
            limit_48 = (count_w << 5) + (count_w << 4);
            limit_72 = (count_w << 6) + (count_w << 3);
            limit_96 = (count_w << 6) + (count_w << 5);
            limit_184 = (count_w << 7) + (count_w << 5) +
                        (count_w << 4) + (count_w << 3);
            limit_208 = (count_w << 7) + (count_w << 6) +
                        (count_w << 4);
            dark_x4 = {count_dark, 2'b00};
            count_x3 = {2'b00, count_y} + {1'b0, count_y, 1'b0};
            highlight_x8 = {count_highlight, 3'b000};

            if (count_y < MIN_CELL_SAMPLES)
                target_gain_q8 = 9'd256;
            else if ((highlight_x8 >= {3'b000, count_y}) ||
                     (sum_y >= limit_208))
                target_gain_q8 = 9'd224;
            else if (sum_y >= limit_184)
                target_gain_q8 = 9'd240;
            else if ((sum_y < limit_24) || (dark_x4 >= count_x3))
                target_gain_q8 = 9'd256;
            else if (sum_y < limit_48)
                target_gain_q8 = 9'd320;
            else if (sum_y < limit_72)
                target_gain_q8 = 9'd288;
            else if (sum_y < limit_96)
                target_gain_q8 = 9'd272;
            else
                target_gain_q8 = 9'd256;
        end
    endfunction

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_d <= 1'b0;
            de_d <= 1'b0;
            cell_x <= 4'd0;
            x_in_cell <= 8'd0;
            line_pixel_count <= 11'd0;
            row_in_cell <= 8'd0;
            band_index <= 4'd0;
            completed_bands <= 4'd0;
            frame_bad <= 1'b0;
            finalize_busy <= 1'b0;
            finalize_index <= 4'd0;
            finalize_band <= 4'd0;
            emit_busy <= 1'b0;
            emit_done_pending <= 1'b0;
            emit_index <= 8'd0;
            raw_gain_valid <= 1'b0;
            raw_gain_addr <= 8'd0;
            raw_gain_q8 <= 9'd256;
            raw_table_done <= 1'b0;
            for (i = 0; i < GRID_COLS; i = i + 1) begin
                y_sum[i] <= 21'd0;
                sample_count[i] <= 13'd0;
                dark_count[i] <= 13'd0;
                highlight_count[i] <= 13'd0;
            end
            for (i = 0; i < TOTAL_CELLS; i = i + 1)
                raw_gain_table[i] <= 9'd256;
        end else begin
            vs_d <= vs_in;
            de_d <= de_in;
            raw_gain_valid <= 1'b0;
            raw_table_done <= 1'b0;

            if (emit_done_pending) begin
                raw_table_done <= 1'b1;
                emit_done_pending <= 1'b0;
            end

            if (emit_busy) begin
                raw_gain_valid <= 1'b1;
                raw_gain_addr <= emit_index;
                raw_gain_q8 <= raw_gain_table[emit_index];
                if (emit_index == TOTAL_CELLS - 1) begin
                    emit_busy <= 1'b0;
                    emit_done_pending <= 1'b1;
                end else begin
                    emit_index <= emit_index + 1'b1;
                end
            end

            if (frame_start) begin
                cell_x <= 4'd0;
                x_in_cell <= 8'd0;
                line_pixel_count <= 11'd0;
                row_in_cell <= 8'd0;
                band_index <= 4'd0;
                completed_bands <= 4'd0;
                frame_bad <= 1'b0;
                finalize_busy <= 1'b0;
                finalize_index <= 4'd0;
                for (i = 0; i < GRID_COLS; i = i + 1) begin
                    y_sum[i] <= 21'd0;
                    sample_count[i] <= 13'd0;
                    dark_count[i] <= 13'd0;
                    highlight_count[i] <= 13'd0;
                end
            end else begin
                if (de_in && !finalize_busy &&
                    (completed_bands < GRID_ROWS)) begin
                    y_sum[cell_x] <= y_sum[cell_x] + y_in;
                    sample_count[cell_x] <= sample_count[cell_x] + 1'b1;
                    if (y_in < 8'd32)
                        dark_count[cell_x] <= dark_count[cell_x] + 1'b1;
                    if (y_in >= 8'd224)
                        highlight_count[cell_x] <=
                            highlight_count[cell_x] + 1'b1;

                    line_pixel_count <= line_pixel_count + 1'b1;
                    if (x_in_cell == CELL_WIDTH - 1) begin
                        x_in_cell <= 8'd0;
                        if (cell_x < GRID_COLS - 1)
                            cell_x <= cell_x + 1'b1;
                    end else begin
                        x_in_cell <= x_in_cell + 1'b1;
                    end
                end

                if (line_end) begin
                    if (line_pixel_count != FRAME_WIDTH)
                        frame_bad <= 1'b1;
                    line_pixel_count <= 11'd0;
                    cell_x <= 4'd0;
                    x_in_cell <= 8'd0;

                    if (!finalize_busy &&
                        (completed_bands < GRID_ROWS)) begin
                        if (row_in_cell == CELL_HEIGHT - 1) begin
                            row_in_cell <= 8'd0;
                            finalize_busy <= 1'b1;
                            finalize_index <= 4'd0;
                            finalize_band <= band_index;
                        end else begin
                            row_in_cell <= row_in_cell + 1'b1;
                        end
                    end
                end

                if (finalize_busy) begin
                    raw_gain_table[{finalize_band, 4'b0000} +
                                   finalize_index] <= target_gain_q8(
                        y_sum[finalize_index],
                        sample_count[finalize_index],
                        dark_count[finalize_index],
                        highlight_count[finalize_index]
                    );
                    if (sample_count[finalize_index] < MIN_CELL_SAMPLES)
                        frame_bad <= 1'b1;
                    y_sum[finalize_index] <= 21'd0;
                    sample_count[finalize_index] <= 13'd0;
                    dark_count[finalize_index] <= 13'd0;
                    highlight_count[finalize_index] <= 13'd0;

                    if (finalize_index == GRID_COLS - 1) begin
                        finalize_busy <= 1'b0;
                        completed_bands <= completed_bands + 1'b1;
                        if ((completed_bands == GRID_ROWS - 1) &&
                            !frame_bad &&
                            (sample_count[finalize_index] >=
                             MIN_CELL_SAMPLES) && !emit_busy) begin
                            emit_busy <= 1'b1;
                            emit_index <= 8'd0;
                        end
                        if (band_index < GRID_ROWS - 1)
                            band_index <= band_index + 1'b1;
                    end else begin
                        finalize_index <= finalize_index + 1'b1;
                    end
                end
            end
        end
    end
endmodule

// Local DRC builds an inactive gain bank from the previous complete frame.
// The bank is swapped only at a video frame boundary. A five-stage datapath
// performs bilinear interpolation without changing active pixel geometry.
module isp_local_drc_16x9 #(
    parameter integer ENABLE = 1,
    parameter integer CELL_WIDTH = 80,
    parameter integer CELL_HEIGHT = 80,
    parameter integer GAIN_MIN_Q8 = 192,
    parameter integer GAIN_MAX_Q8 = 384,
    parameter integer NEIGHBOR_STEP_Q8 = 32
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       raw_gain_valid,
    input  wire [7:0] raw_gain_addr,
    input  wire [8:0] raw_gain_q8,
    input  wire       raw_table_done,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    input  wire [7:0] cb_in,
    input  wire [7:0] cr_in,
    input  wire [7:0] detail_center_in,
    input  wire [7:0] detail_blur_in,
    input  wire       kernel_valid_in,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out,
    output reg  [7:0] detail_center_out,
    output reg  [7:0] detail_blur_out,
    output reg        kernel_valid_out
);
    localparam integer GRID_COLS = 16;
    localparam integer GRID_ROWS = 9;
    localparam integer TOTAL_CELLS = GRID_COLS * GRID_ROWS;

    reg [8:0] raw_gain_table [0:TOTAL_CELLS-1];
    reg [8:0] gain_bank0 [0:TOTAL_CELLS-1];
    reg [8:0] gain_bank1 [0:TOTAL_CELLS-1];

    reg       active_bank;
    reg       build_bank;
    reg       ready_bank;
    reg       bank_ready;
    reg       smoothing;
    reg [7:0] smooth_index;

    reg       vs_coord_d;
    reg       de_coord_d;
    reg [3:0] cell_x;
    reg [3:0] cell_y;
    reg [7:0] x_in_cell;
    reg [7:0] y_in_cell;

    integer i;

    wire video_frame_start = vs_in && !vs_coord_d;
    wire video_line_end = de_coord_d && !de_in;

    function [7:0] safe_grid_index;
        input [3:0] grid_y;
        input [3:0] grid_x;
        begin
            case (grid_y)
                4'd0, 4'd1, 4'd2, 4'd3, 4'd4,
                4'd5, 4'd6, 4'd7, 4'd8: begin
                    case (grid_x)
                        4'd0, 4'd1, 4'd2, 4'd3,
                        4'd4, 4'd5, 4'd6, 4'd7,
                        4'd8, 4'd9, 4'd10, 4'd11,
                        4'd12, 4'd13, 4'd14, 4'd15:
                            safe_grid_index = {grid_y, grid_x};
                        default: safe_grid_index = 8'd0;
                    endcase
                end
                default: safe_grid_index = 8'd0;
            endcase
        end
    endfunction

    wire [7:0] safe_smooth_index = safe_grid_index(
        smooth_index[7:4], smooth_index[3:0]);
    wire [3:0] smooth_x = safe_smooth_index[3:0];
    wire [3:0] smooth_y = safe_smooth_index[7:4];
    wire [7:0] smooth_left_index = (smooth_x == 0) ?
        safe_smooth_index : safe_smooth_index - 1'b1;
    wire [7:0] smooth_right_index = (smooth_x == GRID_COLS - 1) ?
        safe_smooth_index : safe_smooth_index + 1'b1;
    wire [7:0] smooth_up_index = (smooth_y == 0) ?
        safe_smooth_index : safe_smooth_index - GRID_COLS;
    wire [7:0] smooth_down_index = (smooth_y == GRID_ROWS - 1) ?
        safe_smooth_index : safe_smooth_index + GRID_COLS;

    function [8:0] clamp_gain;
        input [10:0] value;
        begin
            if (value < GAIN_MIN_Q8)
                clamp_gain = GAIN_MIN_Q8;
            else if (value > GAIN_MAX_Q8)
                clamp_gain = GAIN_MAX_Q8;
            else
                clamp_gain = value[8:0];
        end
    endfunction

    function [8:0] limit_neighbor;
        input [8:0] center;
        input [8:0] neighbor;
        integer high_limit;
        integer low_limit;
        begin
            high_limit = center + NEIGHBOR_STEP_Q8;
            low_limit = center - NEIGHBOR_STEP_Q8;
            if (neighbor > high_limit)
                limit_neighbor = high_limit[8:0];
            else if (neighbor < low_limit)
                limit_neighbor = low_limit[8:0];
            else
                limit_neighbor = neighbor;
        end
    endfunction

    function [8:0] limit_to_reference;
        input [8:0] value;
        input [8:0] reference;
        integer high_limit;
        integer low_limit;
        begin
            high_limit = reference + NEIGHBOR_STEP_Q8;
            low_limit = reference - NEIGHBOR_STEP_Q8;
            if (value > high_limit)
                limit_to_reference = high_limit[8:0];
            else if (value < low_limit)
                limit_to_reference = low_limit[8:0];
            else
                limit_to_reference = value;
        end
    endfunction

    function [7:0] weight_x_q8;
        input [7:0] position;
        integer scaled;
        begin
            if (CELL_WIDTH == 80)
                scaled = ((position * 205) + 32) >> 6;
            else
                scaled = ((position * 256) + (CELL_WIDTH / 2)) /
                         CELL_WIDTH;
            weight_x_q8 = (scaled > 255) ? 8'd255 : scaled[7:0];
        end
    endfunction

    function [7:0] weight_y_q8;
        input [7:0] position;
        integer scaled;
        begin
            if (CELL_HEIGHT == 80)
                scaled = ((position * 205) + 32) >> 6;
            else
                scaled = ((position * 256) + (CELL_HEIGHT / 2)) /
                         CELL_HEIGHT;
            weight_y_q8 = (scaled > 255) ? 8'd255 : scaled[7:0];
        end
    endfunction

    function [8:0] finish_vertical_interp;
        input [9:0] base_gain;
        input signed [19:0] delta_product;
        integer value;
        begin
            value = base_gain + ($signed(delta_product) >>> 8);
            if (value < GAIN_MIN_Q8)
                finish_vertical_interp = GAIN_MIN_Q8;
            else if (value > GAIN_MAX_Q8)
                finish_vertical_interp = GAIN_MAX_Q8;
            else
                finish_vertical_interp = value[8:0];
        end
    endfunction

    wire [8:0] smooth_center = raw_gain_table[safe_smooth_index];
    wire [8:0] smooth_left = limit_neighbor(
        smooth_center, raw_gain_table[smooth_left_index]);
    wire [8:0] smooth_right = limit_neighbor(
        smooth_center, raw_gain_table[smooth_right_index]);
    wire [8:0] smooth_up = limit_neighbor(
        smooth_center, raw_gain_table[smooth_up_index]);
    wire [8:0] smooth_down = limit_neighbor(
        smooth_center, raw_gain_table[smooth_down_index]);
    wire [12:0] smooth_sum = (smooth_center << 2) + smooth_left +
        smooth_right + smooth_up + smooth_down;
    wire [8:0] smooth_average = clamp_gain((smooth_sum + 4) >> 3);
    wire [8:0] built_left = build_bank ?
        gain_bank1[smooth_left_index] : gain_bank0[smooth_left_index];
    wire [8:0] built_up = build_bank ?
        gain_bank1[smooth_up_index] : gain_bank0[smooth_up_index];
    wire [8:0] smooth_after_left = (smooth_x == 0) ? smooth_average :
        limit_to_reference(smooth_average, built_left);
    wire [8:0] smooth_final = (smooth_y == 0) ? smooth_after_left :
        limit_to_reference(smooth_after_left, built_up);

    wire [7:0] video_index00 = safe_grid_index(cell_y, cell_x);
    wire [3:0] video_cell_x = video_index00[3:0];
    wire [3:0] video_cell_y = video_index00[7:4];
    wire [7:0] video_index10 = (video_cell_x == GRID_COLS - 1) ?
        video_index00 : video_index00 + 1'b1;
    wire [7:0] video_index01 = (video_cell_y == GRID_ROWS - 1) ?
        video_index00 : video_index00 + GRID_COLS;
    wire [7:0] video_index11 = (video_cell_y == GRID_ROWS - 1) ?
        video_index10 : video_index10 + GRID_COLS;
    wire [8:0] gain00_comb = active_bank ?
        gain_bank1[video_index00] : gain_bank0[video_index00];
    wire [8:0] gain10_comb = active_bank ?
        gain_bank1[video_index10] : gain_bank0[video_index10];
    wire [8:0] gain01_comb = active_bank ?
        gain_bank1[video_index01] : gain_bank0[video_index01];
    wire [8:0] gain11_comb = active_bank ?
        gain_bank1[video_index11] : gain_bank0[video_index11];
    wire [7:0] weight_x_comb = weight_x_q8(x_in_cell);
    wire [7:0] weight_y_comb = weight_y_q8(y_in_cell);

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            active_bank <= 1'b0;
            build_bank <= 1'b1;
            ready_bank <= 1'b0;
            bank_ready <= 1'b0;
            smoothing <= 1'b0;
            smooth_index <= 8'd0;
            vs_coord_d <= 1'b0;
            de_coord_d <= 1'b0;
            cell_x <= 4'd0;
            cell_y <= 4'd0;
            x_in_cell <= 8'd0;
            y_in_cell <= 8'd0;
            for (i = 0; i < TOTAL_CELLS; i = i + 1) begin
                raw_gain_table[i] <= 9'd256;
                gain_bank0[i] <= 9'd256;
                gain_bank1[i] <= 9'd256;
            end
        end else begin
            vs_coord_d <= vs_in;
            de_coord_d <= de_in;

            if (raw_gain_valid && (raw_gain_addr < TOTAL_CELLS))
                raw_gain_table[raw_gain_addr] <= raw_gain_q8;

            if (raw_table_done && !smoothing) begin
                build_bank <= !active_bank;
                smoothing <= 1'b1;
                smooth_index <= 8'd0;
            end else if (smoothing) begin
                if (build_bank)
                    gain_bank1[smooth_index] <= smooth_final;
                else
                    gain_bank0[smooth_index] <= smooth_final;

                if (smooth_index == TOTAL_CELLS - 1) begin
                    smoothing <= 1'b0;
                    bank_ready <= 1'b1;
                    ready_bank <= build_bank;
                end else begin
                    smooth_index <= smooth_index + 1'b1;
                end
            end

            if (video_frame_start) begin
                cell_x <= 4'd0;
                cell_y <= 4'd0;
                x_in_cell <= 8'd0;
                y_in_cell <= 8'd0;
                if (bank_ready) begin
                    active_bank <= ready_bank;
                    bank_ready <= 1'b0;
                end
            end else begin
                if (de_in) begin
                    if (x_in_cell == CELL_WIDTH - 1) begin
                        x_in_cell <= 8'd0;
                        if (cell_x < GRID_COLS - 1)
                            cell_x <= cell_x + 1'b1;
                    end else begin
                        x_in_cell <= x_in_cell + 1'b1;
                    end
                end

                if (video_line_end) begin
                    cell_x <= 4'd0;
                    x_in_cell <= 8'd0;
                    if (y_in_cell == CELL_HEIGHT - 1) begin
                        y_in_cell <= 8'd0;
                        if (cell_y < GRID_ROWS - 1)
                            cell_y <= cell_y + 1'b1;
                    end else begin
                        y_in_cell <= y_in_cell + 1'b1;
                    end
                end
            end
        end
    end

    reg       vs_s1, de_s1;
    reg [7:0] y_s1, cb_s1, cr_s1;
    reg [7:0] detail_center_s1, detail_blur_s1;
    reg       kernel_s1;
    reg [8:0] gain00_s1, gain10_s1, gain01_s1, gain11_s1;
    reg [7:0] weight_x_s1, weight_y_s1;

    reg       vs_s2, de_s2;
    reg [7:0] y_s2, cb_s2, cr_s2;
    reg [7:0] detail_center_s2, detail_blur_s2;
    reg       kernel_s2;
    reg [8:0] top_base_s2, bottom_base_s2;
    reg signed [18:0] top_product_s2, bottom_product_s2;
    reg [7:0] weight_y_s2;

    reg       vs_s3, de_s3;
    reg [7:0] y_s3, cb_s3, cr_s3;
    reg [7:0] detail_center_s3, detail_blur_s3;
    reg       kernel_s3;
    reg [9:0] top_gain_s3, bottom_gain_s3;
    reg [7:0] weight_y_s3;

    reg       vs_s4, de_s4;
    reg [7:0] y_s4, cb_s4, cr_s4;
    reg [7:0] detail_center_s4, detail_blur_s4;
    reg       kernel_s4;
    reg [9:0] vertical_base_s4;
    reg signed [19:0] vertical_product_s4;

    wire signed [9:0] top_delta_s1 =
        $signed({1'b0, gain10_s1}) - $signed({1'b0, gain00_s1});
    wire signed [9:0] bottom_delta_s1 =
        $signed({1'b0, gain11_s1}) - $signed({1'b0, gain01_s1});
    wire signed [18:0] top_product_comb =
        top_delta_s1 * $signed({1'b0, weight_x_s1});
    wire signed [18:0] bottom_product_comb =
        bottom_delta_s1 * $signed({1'b0, weight_x_s1});
    wire signed [10:0] top_interp_comb =
        $signed({2'b00, top_base_s2}) +
        ($signed(top_product_s2) >>> 8);
    wire signed [10:0] bottom_interp_comb =
        $signed({2'b00, bottom_base_s2}) +
        ($signed(bottom_product_s2) >>> 8);
    wire signed [10:0] vertical_delta_s3 =
        $signed({1'b0, bottom_gain_s3}) -
        $signed({1'b0, top_gain_s3});
    wire signed [19:0] vertical_product_comb =
        vertical_delta_s3 * $signed({1'b0, weight_y_s3});
    wire [8:0] interpolated_gain_s4 = finish_vertical_interp(
        vertical_base_s4, vertical_product_s4);
    wire [8:0] enabled_gain_s4 = (ENABLE != 0) ?
        interpolated_gain_s4 : 9'd256;
    wire [8:0] dark_protected_gain_s4 =
        (y_s4 < 8'd8) ? 9'd256 :
        ((y_s4 < 8'd24) && (enabled_gain_s4 > 9'd272)) ? 9'd272 :
        ((y_s4 < 8'd48) && (enabled_gain_s4 > 9'd304)) ? 9'd304 :
        enabled_gain_s4;
    wire [8:0] protected_gain_s4 =
        ((y_s4 >= 8'd224) && (dark_protected_gain_s4 > 9'd256)) ?
        9'd256 : dark_protected_gain_s4;
    wire [17:0] scaled_luma_product = y_s4 * protected_gain_s4;
    wire [9:0] scaled_luma_rounded =
        (scaled_luma_product + 18'd128) >> 8;
    wire [7:0] scaled_luma = (scaled_luma_rounded > 10'd255) ?
        8'd255 : scaled_luma_rounded[7:0];

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_s1 <= 1'b0; de_s1 <= 1'b0;
            y_s1 <= 8'd0; cb_s1 <= 8'd0; cr_s1 <= 8'd0;
            detail_center_s1 <= 8'd0; detail_blur_s1 <= 8'd0;
            kernel_s1 <= 1'b0;
            gain00_s1 <= 9'd256; gain10_s1 <= 9'd256;
            gain01_s1 <= 9'd256; gain11_s1 <= 9'd256;
            weight_x_s1 <= 8'd0; weight_y_s1 <= 8'd0;

            vs_s2 <= 1'b0; de_s2 <= 1'b0;
            y_s2 <= 8'd0; cb_s2 <= 8'd0; cr_s2 <= 8'd0;
            detail_center_s2 <= 8'd0; detail_blur_s2 <= 8'd0;
            kernel_s2 <= 1'b0;
            top_base_s2 <= 9'd256; bottom_base_s2 <= 9'd256;
            top_product_s2 <= 19'sd0; bottom_product_s2 <= 19'sd0;
            weight_y_s2 <= 8'd0;

            vs_s3 <= 1'b0; de_s3 <= 1'b0;
            y_s3 <= 8'd0; cb_s3 <= 8'd0; cr_s3 <= 8'd0;
            detail_center_s3 <= 8'd0; detail_blur_s3 <= 8'd0;
            kernel_s3 <= 1'b0;
            top_gain_s3 <= 10'd256; bottom_gain_s3 <= 10'd256;
            weight_y_s3 <= 8'd0;

            vs_s4 <= 1'b0; de_s4 <= 1'b0;
            y_s4 <= 8'd0; cb_s4 <= 8'd0; cr_s4 <= 8'd0;
            detail_center_s4 <= 8'd0; detail_blur_s4 <= 8'd0;
            kernel_s4 <= 1'b0;
            vertical_base_s4 <= 10'd256;
            vertical_product_s4 <= 20'sd0;

            vs_out <= 1'b0; de_out <= 1'b0;
            y_out <= 8'd0; cb_out <= 8'd0; cr_out <= 8'd0;
            detail_center_out <= 8'd0;
            detail_blur_out <= 8'd0;
            kernel_valid_out <= 1'b0;
        end else begin
            vs_s1 <= vs_in;
            de_s1 <= de_in;
            y_s1 <= de_in ? y_in : 8'd0;
            cb_s1 <= de_in ? cb_in : 8'd0;
            cr_s1 <= de_in ? cr_in : 8'd0;
            detail_center_s1 <= de_in ? detail_center_in : 8'd0;
            detail_blur_s1 <= de_in ? detail_blur_in : 8'd0;
            kernel_s1 <= de_in && kernel_valid_in;
            gain00_s1 <= gain00_comb;
            gain10_s1 <= gain10_comb;
            gain01_s1 <= gain01_comb;
            gain11_s1 <= gain11_comb;
            weight_x_s1 <= weight_x_comb;
            weight_y_s1 <= weight_y_comb;

            vs_s2 <= vs_s1;
            de_s2 <= de_s1;
            y_s2 <= y_s1; cb_s2 <= cb_s1; cr_s2 <= cr_s1;
            detail_center_s2 <= detail_center_s1;
            detail_blur_s2 <= detail_blur_s1;
            kernel_s2 <= kernel_s1;
            top_base_s2 <= gain00_s1;
            bottom_base_s2 <= gain01_s1;
            top_product_s2 <= top_product_comb;
            bottom_product_s2 <= bottom_product_comb;
            weight_y_s2 <= weight_y_s1;

            vs_s3 <= vs_s2;
            de_s3 <= de_s2;
            y_s3 <= y_s2; cb_s3 <= cb_s2; cr_s3 <= cr_s2;
            detail_center_s3 <= detail_center_s2;
            detail_blur_s3 <= detail_blur_s2;
            kernel_s3 <= kernel_s2;
            top_gain_s3 <= top_interp_comb[9:0];
            bottom_gain_s3 <= bottom_interp_comb[9:0];
            weight_y_s3 <= weight_y_s2;

            vs_s4 <= vs_s3;
            de_s4 <= de_s3;
            y_s4 <= y_s3; cb_s4 <= cb_s3; cr_s4 <= cr_s3;
            detail_center_s4 <= detail_center_s3;
            detail_blur_s4 <= detail_blur_s3;
            kernel_s4 <= kernel_s3;
            vertical_base_s4 <= top_gain_s3;
            vertical_product_s4 <= vertical_product_comb;

            vs_out <= vs_s4;
            de_out <= de_s4;
            if (de_s4) begin
                y_out <= scaled_luma;
                cb_out <= cb_s4;
                cr_out <= cr_s4;
                detail_center_out <= detail_center_s4;
                detail_blur_out <= detail_blur_s4;
                kernel_valid_out <= kernel_s4;
            end else begin
                y_out <= 8'd0;
                cb_out <= 8'd0;
                cr_out <= 8'd0;
                detail_center_out <= 8'd0;
                detail_blur_out <= 8'd0;
                kernel_valid_out <= 1'b0;
            end
        end
    end
endmodule

// Shared causal 3x3 feature generator. One set of six line memories produces
// all candidates needed by the camera pipeline. The direct center path is
// delayed by exactly the same number of clocks as the spatial candidates, so
// selecting a candidate never changes VS/DE timing or the active pixel count.
module isp_3x3_features #(
    parameter integer IMG_WIDTH = 1280
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    input  wire [7:0] cb_in,
    input  wire [7:0] cr_in,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] center_y,
    output reg  [7:0] center_cb,
    output reg  [7:0] center_cr,
    output reg  [7:0] median_y,
    output reg  [7:0] gaussian_y,
    output reg  [7:0] gaussian_cb,
    output reg  [7:0] gaussian_cr,
    output reg  [7:0] min_y,
    output reg  [7:0] max_y,
    output reg        kernel_valid
);
    reg [10:0] wr_ptr;
    reg [10:0] wr_ptr_d1;
    reg [10:0] active_x;
    reg [10:0] active_y;
    reg        de_in_d;
    reg        vs_d1;
    reg        de_d1;
    reg [3:0]  kernel_valid_pipe;

    reg [7:0] y_row3, cb_row3, cr_row3;
    wire [7:0] y_row2, cb_row2, cr_row2;
    wire [7:0] y_row1, cb_row1, cr_row1;

    reg [7:0] y_bypass_d1, y_bypass_d2, y_bypass_d3, y_bypass_d4;
    reg [7:0] cb_bypass_d1, cb_bypass_d2, cb_bypass_d3, cb_bypass_d4;
    reg [7:0] cr_bypass_d1, cr_bypass_d2, cr_bypass_d3, cr_bypass_d4;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= 11'd0;
            wr_ptr_d1 <= 11'd0;
            active_x <= 11'd0;
            active_y <= 11'd0;
            de_in_d <= 1'b0;
            vs_d1 <= 1'b0;
            de_d1 <= 1'b0;
            kernel_valid_pipe <= 4'd0;
            {y_row3, cb_row3, cr_row3} <= 24'd0;
            {y_bypass_d1, y_bypass_d2,
             y_bypass_d3, y_bypass_d4} <= 32'd0;
            {cb_bypass_d1, cb_bypass_d2,
             cb_bypass_d3, cb_bypass_d4} <= 32'd0;
            {cr_bypass_d1, cr_bypass_d2,
             cr_bypass_d3, cr_bypass_d4} <= 32'd0;
        end else begin
            vs_d1 <= vs_in;
            de_d1 <= de_in;
            de_in_d <= de_in;
            wr_ptr_d1 <= wr_ptr;

            if (vs_in) begin
                wr_ptr <= 11'd0;
                active_x <= 11'd0;
                active_y <= 11'd0;
            end else if (de_in) begin
                if (wr_ptr == IMG_WIDTH - 1)
                    wr_ptr <= 11'd0;
                else
                    wr_ptr <= wr_ptr + 1'b1;
                if (active_x == IMG_WIDTH - 1)
                    active_x <= 11'd0;
                else
                    active_x <= active_x + 1'b1;
            end else begin
                active_x <= 11'd0;
            end

            if (!vs_in && de_in_d && !de_in && active_y != 11'h7ff)
                active_y <= active_y + 1'b1;

            kernel_valid_pipe <= {
                kernel_valid_pipe[2:0],
                de_in && !vs_in && (active_x >= 11'd2) &&
                (active_y >= 11'd2)
            };

            {y_row3, cb_row3, cr_row3} <= {y_in, cb_in, cr_in};
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

    line_buf u_isp_y_buf_1 (
        .wr_data(y_in), .wr_addr(wr_ptr), .wr_en(de_in),
        .wr_clk(pclk), .wr_rst(~rst_n),
        .rd_data(y_row2), .rd_addr(wr_ptr),
        .rd_clk(pclk), .rd_rst(~rst_n)
    );
    line_buf u_isp_y_buf_2 (
        .wr_data(y_row2), .wr_addr(wr_ptr_d1), .wr_en(de_d1),
        .wr_clk(pclk), .wr_rst(~rst_n),
        .rd_data(y_row1), .rd_addr(wr_ptr),
        .rd_clk(pclk), .rd_rst(~rst_n)
    );
    line_buf u_isp_cb_buf_1 (
        .wr_data(cb_in), .wr_addr(wr_ptr), .wr_en(de_in),
        .wr_clk(pclk), .wr_rst(~rst_n),
        .rd_data(cb_row2), .rd_addr(wr_ptr),
        .rd_clk(pclk), .rd_rst(~rst_n)
    );
    line_buf u_isp_cb_buf_2 (
        .wr_data(cb_row2), .wr_addr(wr_ptr_d1), .wr_en(de_d1),
        .wr_clk(pclk), .wr_rst(~rst_n),
        .rd_data(cb_row1), .rd_addr(wr_ptr),
        .rd_clk(pclk), .rd_rst(~rst_n)
    );
    line_buf u_isp_cr_buf_1 (
        .wr_data(cr_in), .wr_addr(wr_ptr), .wr_en(de_in),
        .wr_clk(pclk), .wr_rst(~rst_n),
        .rd_data(cr_row2), .rd_addr(wr_ptr),
        .rd_clk(pclk), .rd_rst(~rst_n)
    );
    line_buf u_isp_cr_buf_2 (
        .wr_data(cr_row2), .wr_addr(wr_ptr_d1), .wr_en(de_d1),
        .wr_clk(pclk), .wr_rst(~rst_n),
        .rd_data(cr_row1), .rd_addr(wr_ptr),
        .rd_clk(pclk), .rd_rst(~rst_n)
    );

    reg [7:0] y_p11, y_p12, y_p13;
    reg [7:0] y_p21, y_p22, y_p23;
    reg [7:0] y_p31, y_p32, y_p33;
    reg [7:0] cb_p11, cb_p12, cb_p13;
    reg [7:0] cb_p21, cb_p22, cb_p23;
    reg [7:0] cb_p31, cb_p32, cb_p33;
    reg [7:0] cr_p11, cr_p12, cr_p13;
    reg [7:0] cr_p21, cr_p22, cr_p23;
    reg [7:0] cr_p31, cr_p32, cr_p33;
    reg       vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {y_p11, y_p12, y_p13, y_p21, y_p22, y_p23,
             y_p31, y_p32, y_p33} <= 72'd0;
            {cb_p11, cb_p12, cb_p13, cb_p21, cb_p22, cb_p23,
             cb_p31, cb_p32, cb_p33} <= 72'd0;
            {cr_p11, cr_p12, cr_p13, cr_p21, cr_p22, cr_p23,
             cr_p31, cr_p32, cr_p33} <= 72'd0;
            vs_d2 <= 1'b0;
            de_d2 <= 1'b0;
        end else begin
            vs_d2 <= vs_d1;
            de_d2 <= de_d1;
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

    function [23:0] isp_sort3;
        input [7:0] a;
        input [7:0] b;
        input [7:0] c;
        reg [7:0] hi;
        reg [7:0] mid;
        reg [7:0] lo;
        begin
            if (a >= b && a >= c) begin
                hi = a;
                if (b >= c) begin mid = b; lo = c; end
                else begin mid = c; lo = b; end
            end else if (b >= a && b >= c) begin
                hi = b;
                if (a >= c) begin mid = a; lo = c; end
                else begin mid = c; lo = a; end
            end else begin
                hi = c;
                if (a >= b) begin mid = a; lo = b; end
                else begin mid = b; lo = a; end
            end
            isp_sort3 = {hi, mid, lo};
        end
    endfunction

    function [7:0] isp_min3;
        input [7:0] a;
        input [7:0] b;
        input [7:0] c;
        begin
            isp_min3 = (a <= b && a <= c) ? a : ((b <= c) ? b : c);
        end
    endfunction

    function [7:0] isp_max3;
        input [7:0] a;
        input [7:0] b;
        input [7:0] c;
        begin
            isp_max3 = (a >= b && a >= c) ? a : ((b >= c) ? b : c);
        end
    endfunction

    reg [7:0] row_max1, row_med1, row_min1;
    reg [7:0] row_max2, row_med2, row_min2;
    reg [7:0] row_max3, row_med3, row_min3;
    reg [7:0] row3_neighbor_max, row3_neighbor_min;
    reg [9:0] y_sum1, y_sum3, cb_sum1, cb_sum3, cr_sum1, cr_sum3;
    reg [10:0] y_sum2, cb_sum2, cr_sum2;
    reg vs_d3, de_d3;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {row_max1, row_med1, row_min1,
             row_max2, row_med2, row_min2,
             row_max3, row_med3, row_min3} <= 72'd0;
            row3_neighbor_max <= 8'd0;
            row3_neighbor_min <= 8'd0;
            y_sum1 <= 10'd0; y_sum2 <= 11'd0; y_sum3 <= 10'd0;
            cb_sum1 <= 10'd0; cb_sum2 <= 11'd0; cb_sum3 <= 10'd0;
            cr_sum1 <= 10'd0; cr_sum2 <= 11'd0; cr_sum3 <= 10'd0;
            vs_d3 <= 1'b0;
            de_d3 <= 1'b0;
        end else begin
            {row_max1, row_med1, row_min1} <=
                isp_sort3(y_p11, y_p12, y_p13);
            {row_max2, row_med2, row_min2} <=
                isp_sort3(y_p21, y_p22, y_p23);
            {row_max3, row_med3, row_min3} <=
                isp_sort3(y_p31, y_p32, y_p33);
            // p31 is the current pixel in this causal 3x3 window. Keep it in
            // the median/Gaussian candidates, but exclude it from the
            // neighbour-flatness range used to classify isolated impulses.
            row3_neighbor_max <= (y_p32 >= y_p33) ? y_p32 : y_p33;
            row3_neighbor_min <= (y_p32 <= y_p33) ? y_p32 : y_p33;
            y_sum1 <= {2'd0, y_p11} + ({2'd0, y_p12} << 1) +
                      {2'd0, y_p13};
            y_sum2 <= ({3'd0, y_p21} << 1) +
                      ({3'd0, y_p22} << 2) +
                      ({3'd0, y_p23} << 1);
            y_sum3 <= {2'd0, y_p31} + ({2'd0, y_p32} << 1) +
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
            vs_d3 <= vs_d2;
            de_d3 <= de_d2;
        end
    end

    wire [7:0] median_of_row_max =
        isp_min3(row_max1, row_max2, row_max3);
    wire [7:0] median_of_row_med =
        (isp_sort3(row_med1, row_med2, row_med3) >> 8) & 8'hff;
    wire [7:0] median_of_row_min =
        isp_max3(row_min1, row_min2, row_min3);
    wire [7:0] median_comb =
        (isp_sort3(median_of_row_max, median_of_row_med,
                   median_of_row_min) >> 8) & 8'hff;
    wire [7:0] min_comb = isp_min3(
        row_min1, row_min2, row3_neighbor_min
    );
    wire [7:0] max_comb = isp_max3(
        row_max1, row_max2, row3_neighbor_max
    );

    reg [11:0] y_total, cb_total, cr_total;
    reg [7:0] median_d4, min_d4, max_d4;
    reg vs_d4, de_d4;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_total <= 12'd0;
            cb_total <= 12'd0;
            cr_total <= 12'd0;
            median_d4 <= 8'd0;
            min_d4 <= 8'd0;
            max_d4 <= 8'd0;
            vs_d4 <= 1'b0;
            de_d4 <= 1'b0;
        end else begin
            y_total <= {2'd0, y_sum1} + {1'd0, y_sum2} +
                       {2'd0, y_sum3};
            cb_total <= {2'd0, cb_sum1} + {1'd0, cb_sum2} +
                        {2'd0, cb_sum3};
            cr_total <= {2'd0, cr_sum1} + {1'd0, cr_sum2} +
                        {2'd0, cr_sum3};
            median_d4 <= median_comb;
            min_d4 <= min_comb;
            max_d4 <= max_comb;
            vs_d4 <= vs_d3;
            de_d4 <= de_d3;
        end
    end

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out <= 1'b0;
            de_out <= 1'b0;
            center_y <= 8'd0;
            center_cb <= 8'd128;
            center_cr <= 8'd128;
            median_y <= 8'd0;
            gaussian_y <= 8'd0;
            gaussian_cb <= 8'd128;
            gaussian_cr <= 8'd128;
            min_y <= 8'd0;
            max_y <= 8'd0;
            kernel_valid <= 1'b0;
        end else begin
            vs_out <= vs_d4;
            de_out <= de_d4;
            kernel_valid <= de_d4 && kernel_valid_pipe[3];
            if (de_d4) begin
                center_y <= y_bypass_d4;
                center_cb <= cb_bypass_d4;
                center_cr <= cr_bypass_d4;
                if (kernel_valid_pipe[3]) begin
                    median_y <= median_d4;
                    gaussian_y <= y_total[11:4];
                    gaussian_cb <= cb_total[11:4];
                    gaussian_cr <= cr_total[11:4];
                    min_y <= min_d4;
                    max_y <= max_d4;
                end else begin
                    median_y <= y_bypass_d4;
                    gaussian_y <= y_bypass_d4;
                    gaussian_cb <= cb_bypass_d4;
                    gaussian_cr <= cr_bypass_d4;
                    min_y <= y_bypass_d4;
                    max_y <= y_bypass_d4;
                end
            end else begin
                center_y <= 8'd0;
                center_cb <= 8'd128;
                center_cr <= 8'd128;
                median_y <= 8'd0;
                gaussian_y <= 8'd0;
                gaussian_cb <= 8'd128;
                gaussian_cr <= 8'd128;
                min_y <= 8'd0;
                max_y <= 8'd0;
            end
        end
    end
endmodule

// Conservative camera cleanup. Moderate isolated luma deviations are replaced
// only when the surrounding window is flat. Chroma smoothing is also limited
// to flat regions and dark chroma is pulled toward neutral without touching
// strong color or luma edges.
module isp_camera_spatial_filter #(
    parameter integer IMPULSE_THRESHOLD = 24,
    parameter integer IMPULSE_LIMIT = 96,
    parameter integer IMPULSE_FLAT_RANGE = 24,
    parameter integer CHROMA_EDGE_THRESHOLD = 48
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] center_y,
    input  wire [7:0] center_cb,
    input  wire [7:0] center_cr,
    input  wire [7:0] median_y,
    input  wire [7:0] gaussian_y,
    input  wire [7:0] gaussian_cb,
    input  wire [7:0] gaussian_cr,
    input  wire [7:0] min_y,
    input  wire [7:0] max_y,
    input  wire       kernel_valid,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out,
    output reg  [7:0] blur_y_out,
    output reg        kernel_valid_out
);
    wire [7:0] impulse_delta = (center_y >= median_y) ?
        (center_y - median_y) : (median_y - center_y);
    // min_y/max_y describe the eight causal neighbours and intentionally do
    // not include center_y. This lets a moderate isolated sensor impulse be
    // distinguished from texture in the surrounding area.
    wire [7:0] edge_range = max_y - min_y;
    wire replace_impulse = kernel_valid &&
        (impulse_delta > IMPULSE_THRESHOLD) &&
        (impulse_delta <= IMPULSE_LIMIT) &&
        (edge_range <= IMPULSE_FLAT_RANGE);
    wire [7:0] selected_y = replace_impulse ? median_y : center_y;
    wire chroma_flat = kernel_valid &&
        (edge_range < CHROMA_EDGE_THRESHOLD);

    function [7:0] blend_chroma;
        input [7:0] center_value;
        input [7:0] blur_value;
        input [7:0] luma_value;
        input       enable_blend;
        reg [7:0] delta;
        reg [7:0] mixed;
        begin
            mixed = center_value;
            if (enable_blend) begin
                if (blur_value >= center_value) begin
                    delta = blur_value - center_value;
                    if (luma_value < 8'd48)
                        mixed = center_value + ((delta + 1'b1) >> 1);
                    else
                        mixed = center_value + ((delta + 2'd2) >> 2);
                end else begin
                    delta = center_value - blur_value;
                    if (luma_value < 8'd48)
                        mixed = center_value - ((delta + 1'b1) >> 1);
                    else
                        mixed = center_value - ((delta + 2'd2) >> 2);
                end
            end
            blend_chroma = mixed;
        end
    endfunction

    function [7:0] dark_chroma_limit;
        input [7:0] chroma_value;
        input [7:0] luma_value;
        input       enable_limit;
        reg [7:0] distance;
        reg [11:0] scaled;
        begin
            if (!enable_limit || luma_value >= 8'd48) begin
                dark_chroma_limit = chroma_value;
            end else begin
                if (chroma_value >= 8'd128)
                    distance = chroma_value - 8'd128;
                else
                    distance = 8'd128 - chroma_value;

                if (luma_value < 8'd24)
                    scaled = ({4'd0, distance} * 4'd5 + 4'd4) >> 3;
                else
                    scaled = ({4'd0, distance} * 4'd13 + 4'd8) >> 4;

                if (chroma_value >= 8'd128)
                    dark_chroma_limit = 8'd128 + scaled[7:0];
                else
                    dark_chroma_limit = 8'd128 - scaled[7:0];
            end
        end
    endfunction

    wire [7:0] cb_blended = blend_chroma(
        center_cb, gaussian_cb, selected_y, chroma_flat
    );
    wire [7:0] cr_blended = blend_chroma(
        center_cr, gaussian_cr, selected_y, chroma_flat
    );
    wire [7:0] cb_limited = dark_chroma_limit(
        cb_blended, selected_y, chroma_flat
    );
    wire [7:0] cr_limited = dark_chroma_limit(
        cr_blended, selected_y, chroma_flat
    );

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out <= 1'b0;
            de_out <= 1'b0;
            y_out <= 8'd0;
            cb_out <= 8'd128;
            cr_out <= 8'd128;
            blur_y_out <= 8'd0;
            kernel_valid_out <= 1'b0;
        end else begin
            vs_out <= vs_in;
            de_out <= de_in;
            kernel_valid_out <= de_in && kernel_valid;
            if (de_in) begin
                y_out <= selected_y;
                cb_out <= cb_limited;
                cr_out <= cr_limited;
                blur_y_out <= gaussian_y;
            end else begin
                y_out <= 8'd0;
                cb_out <= 8'd128;
                cr_out <= 8'd128;
                blur_y_out <= 8'd0;
            end
        end
    end
endmodule

// Per-channel 32-bin luma histogram. A fixed 1/16 raster sample keeps the
// counters small. Banks alternate by frame: one bank is scanned while the
// other is cleared and then filled, so no partial-frame statistics are used.
module isp_luma_histogram_32 #(
    parameter integer MIN_FRAME_SAMPLES = 50000
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [7:0]  y_in,
    input  wire [7:0]  cb_in,
    input  wire [7:0]  cr_in,
    output reg         stats_valid,
    output reg  [7:0]  p05,
    output reg  [7:0]  p10,
    output reg  [7:0]  p50,
    output reg  [7:0]  p95,
    output reg  [19:0] sample_total,
    output reg  [19:0] dark_count,
    output reg  [19:0] shadow_count,
    output reg  [19:0] highlight_count,
    output reg  [19:0] near_clip_count,
    output reg  [19:0] clip_count
);
    reg [19:0] hist_bank0 [0:31];
    reg [19:0] hist_bank1 [0:31];
    reg        write_bank;
    reg        clear_bank;
    reg        clear_active;
    reg [5:0]  clear_index;

    reg [11:0] active_x;
    reg [11:0] active_y;
    reg        de_in_d;
    reg        vs_in_d;
    reg [19:0] frame_sample_count;
    reg [19:0] frame_dark_count;
    reg [19:0] frame_shadow_count;
    reg [19:0] frame_highlight_count;
    reg [19:0] frame_near_clip_count;
    reg [19:0] frame_clip_count;

    reg        scan_active;
    reg        scan_bank;
    reg [5:0]  scan_index;
    reg [20:0] scan_accum;
    reg [19:0] scan_total;
    reg [19:0] scan_dark;
    reg [19:0] scan_shadow;
    reg [19:0] scan_highlight;
    reg [19:0] scan_near_clip;
    reg [19:0] scan_clip;
    reg [19:0] threshold_05;
    reg [19:0] threshold_10;
    reg [19:0] threshold_50;
    reg [19:0] threshold_95;
    reg [7:0]  p05_work, p10_work, p50_work, p95_work;
    reg        p05_found, p10_found, p50_found, p95_found;

    integer reset_index;

    wire frame_start = vs_in && !vs_in_d;
    wire sample_enable = de_in && !clear_active &&
        (active_x[1:0] == 2'b00) && (active_y[1:0] == 2'b00);
    wire [4:0] sample_bin = y_in[7:3];
    wire [19:0] scan_bin_value = scan_bank ?
        hist_bank1[scan_index[4:0]] : hist_bank0[scan_index[4:0]];
    wire [20:0] scan_accum_next = scan_accum +
        {1'b0, scan_bin_value};
    wire [7:0] scan_bin_center = {scan_index[4:0], 3'b100};
    wire [7:0] p05_next = (!p05_found &&
        (scan_accum_next >= {1'b0, threshold_05})) ?
        scan_bin_center : p05_work;
    wire [7:0] p10_next = (!p10_found &&
        (scan_accum_next >= {1'b0, threshold_10})) ?
        scan_bin_center : p10_work;
    wire [7:0] p50_next = (!p50_found &&
        (scan_accum_next >= {1'b0, threshold_50})) ?
        scan_bin_center : p50_work;
    wire [7:0] p95_next = (!p95_found &&
        (scan_accum_next >= {1'b0, threshold_95})) ?
        scan_bin_center : p95_work;

    wire [27:0] frame_count_x13 = frame_sample_count * 5'd13;
    wire [27:0] frame_count_x26 = frame_sample_count * 6'd26;
    wire [19:0] frame_threshold_05 =
        (frame_count_x13[27:8] == 20'd0) ? 20'd1 :
        frame_count_x13[27:8];
    wire [19:0] frame_threshold_10 =
        (frame_count_x26[27:8] == 20'd0) ? 20'd1 :
        frame_count_x26[27:8];
    wire [19:0] frame_threshold_50 =
        (frame_sample_count < 20'd2) ? 20'd1 :
        (frame_sample_count >> 1);
    wire [19:0] frame_threshold_95 =
        frame_sample_count - frame_threshold_05;
    wire unused_chroma = ^{cb_in, cr_in};

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            write_bank <= 1'b0;
            clear_bank <= 1'b1;
            clear_active <= 1'b0;
            clear_index <= 6'd0;
            active_x <= 12'd0;
            active_y <= 12'd0;
            de_in_d <= 1'b0;
            vs_in_d <= 1'b0;
            frame_sample_count <= 20'd0;
            frame_dark_count <= 20'd0;
            frame_shadow_count <= 20'd0;
            frame_highlight_count <= 20'd0;
            frame_near_clip_count <= 20'd0;
            frame_clip_count <= 20'd0;
            scan_active <= 1'b0;
            scan_bank <= 1'b0;
            scan_index <= 6'd0;
            scan_accum <= 21'd0;
            scan_total <= 20'd0;
            scan_dark <= 20'd0;
            scan_shadow <= 20'd0;
            scan_highlight <= 20'd0;
            scan_near_clip <= 20'd0;
            scan_clip <= 20'd0;
            threshold_05 <= 20'd1;
            threshold_10 <= 20'd1;
            threshold_50 <= 20'd1;
            threshold_95 <= 20'd1;
            p05_work <= 8'd0;
            p10_work <= 8'd0;
            p50_work <= 8'd0;
            p95_work <= 8'd0;
            p05_found <= 1'b0;
            p10_found <= 1'b0;
            p50_found <= 1'b0;
            p95_found <= 1'b0;
            stats_valid <= 1'b0;
            p05 <= 8'd0;
            p10 <= 8'd0;
            p50 <= 8'd0;
            p95 <= 8'd0;
            sample_total <= 20'd0;
            dark_count <= 20'd0;
            shadow_count <= 20'd0;
            highlight_count <= 20'd0;
            near_clip_count <= 20'd0;
            clip_count <= 20'd0;
            for (reset_index = 0; reset_index < 32;
                 reset_index = reset_index + 1) begin
                hist_bank0[reset_index] <= 20'd0;
                hist_bank1[reset_index] <= 20'd0;
            end
        end else begin
            stats_valid <= 1'b0;
            vs_in_d <= vs_in;
            de_in_d <= de_in;

            if (frame_start) begin
                active_x <= 12'd0;
                active_y <= 12'd0;
                if (frame_sample_count >= MIN_FRAME_SAMPLES) begin
                    scan_active <= 1'b1;
                    scan_bank <= write_bank;
                    scan_index <= 6'd0;
                    scan_accum <= 21'd0;
                    scan_total <= frame_sample_count;
                    scan_dark <= frame_dark_count;
                    scan_shadow <= frame_shadow_count;
                    scan_highlight <= frame_highlight_count;
                    scan_near_clip <= frame_near_clip_count;
                    scan_clip <= frame_clip_count;
                    threshold_05 <= frame_threshold_05;
                    threshold_10 <= frame_threshold_10;
                    threshold_50 <= frame_threshold_50;
                    threshold_95 <= frame_threshold_95;
                    p05_work <= 8'd0;
                    p10_work <= 8'd0;
                    p50_work <= 8'd0;
                    p95_work <= 8'd0;
                    p05_found <= 1'b0;
                    p10_found <= 1'b0;
                    p50_found <= 1'b0;
                    p95_found <= 1'b0;
                end
                write_bank <= ~write_bank;
                clear_bank <= ~write_bank;
                clear_active <= 1'b1;
                clear_index <= 6'd0;
                frame_sample_count <= 20'd0;
                frame_dark_count <= 20'd0;
                frame_shadow_count <= 20'd0;
                frame_highlight_count <= 20'd0;
                frame_near_clip_count <= 20'd0;
                frame_clip_count <= 20'd0;
            end else begin
                if (de_in) begin
                    if (active_x != 12'hfff)
                        active_x <= active_x + 1'b1;
                end else begin
                    active_x <= 12'd0;
                end
                if (de_in_d && !de_in && active_y != 12'hfff)
                    active_y <= active_y + 1'b1;

                if (clear_active) begin
                    if (clear_bank)
                        hist_bank1[clear_index[4:0]] <= 20'd0;
                    else
                        hist_bank0[clear_index[4:0]] <= 20'd0;
                    if (clear_index == 6'd31)
                        clear_active <= 1'b0;
                    else
                        clear_index <= clear_index + 1'b1;
                end else if (sample_enable) begin
                    if (write_bank)
                        hist_bank1[sample_bin] <=
                            hist_bank1[sample_bin] + 1'b1;
                    else
                        hist_bank0[sample_bin] <=
                            hist_bank0[sample_bin] + 1'b1;
                    frame_sample_count <= frame_sample_count + 1'b1;
                    if (y_in < 8'd32)
                        frame_dark_count <= frame_dark_count + 1'b1;
                    if (y_in < 8'd64)
                        frame_shadow_count <= frame_shadow_count + 1'b1;
                    if (y_in >= 8'd224)
                        frame_highlight_count <= frame_highlight_count + 1'b1;
                    if (y_in >= 8'd240)
                        frame_near_clip_count <= frame_near_clip_count + 1'b1;
                    if (y_in >= 8'd248)
                        frame_clip_count <= frame_clip_count + 1'b1;
                end
            end

            if (scan_active) begin
                scan_accum <= scan_accum_next;
                p05_work <= p05_next;
                p10_work <= p10_next;
                p50_work <= p50_next;
                p95_work <= p95_next;
                if (!p05_found &&
                    scan_accum_next >= {1'b0, threshold_05})
                    p05_found <= 1'b1;
                if (!p10_found &&
                    scan_accum_next >= {1'b0, threshold_10})
                    p10_found <= 1'b1;
                if (!p50_found &&
                    scan_accum_next >= {1'b0, threshold_50})
                    p50_found <= 1'b1;
                if (!p95_found &&
                    scan_accum_next >= {1'b0, threshold_95})
                    p95_found <= 1'b1;

                if (scan_index == 6'd31) begin
                    scan_active <= 1'b0;
                    stats_valid <= 1'b1;
                    p05 <= p05_next;
                    p10 <= p10_next;
                    p50 <= p50_next;
                    p95 <= p95_next;
                    sample_total <= scan_total;
                    dark_count <= scan_dark;
                    shadow_count <= scan_shadow;
                    highlight_count <= scan_highlight;
                    near_clip_count <= scan_near_clip;
                    clip_count <= scan_clip;
                end else begin
                    scan_index <= scan_index + 1'b1;
                end
            end
        end
    end
endmodule

// Scene classification and slow Q8 strength control. Every instance owns its
// state; no camera or HDMI channel can steer another channel's tone curve.
module isp_scene_controller #(
    parameter integer MAX_STRENGTH_Q8 = 128,
    parameter integer CONFIRM_FRAMES = 6,
    parameter integer MAX_STEP_Q8 = 8
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        stats_valid,
    input  wire [7:0]  p05,
    input  wire [7:0]  p10,
    input  wire [7:0]  p50,
    input  wire [7:0]  p95,
    input  wire [19:0] sample_total,
    input  wire [19:0] dark_count,
    input  wire [19:0] shadow_count,
    input  wire [19:0] highlight_count,
    input  wire [19:0] near_clip_count,
    input  wire [19:0] clip_count,
    output reg  [2:0]  scene_mode,
    output reg  [8:0]  strength_q8
);
    localparam [2:0] SCENE_NORMAL    = 3'd0;
    localparam [2:0] SCENE_DARK      = 3'd1;
    localparam [2:0] SCENE_BRIGHT    = 3'd2;
    localparam [2:0] SCENE_BACKLIGHT = 3'd3;
    localparam [2:0] SCENE_LOWCONTR  = 3'd4;

    reg [2:0] scene_candidate;
    reg [3:0] confirm_count;

    wire [7:0] percentile_range = p95 - p05;
    wire [23:0] total_ext = {4'd0, sample_total};
    wire [23:0] shadow_x4 = {2'd0, shadow_count, 2'b00};
    wire [23:0] highlight_x4 = {2'd0, highlight_count, 2'b00};
    wire [23:0] highlight_x16 = {highlight_count, 4'b0000};
    wire [24:0] highlight_x32 = {highlight_count, 5'b00000};
    wire [23:0] near_clip_x16 = {near_clip_count, 4'b0000};
    wire [25:0] clip_x64 = {clip_count, 6'b000000};
    wire [25:0] total_ext26 = {6'd0, sample_total};

    wire scene_backlight = (shadow_x4 > total_ext) &&
        (highlight_x16 > total_ext);
    wire scene_bright = (p50 >= 8'd176) ||
        (highlight_x4 > total_ext) || (near_clip_x16 > total_ext);
    wire scene_dark = (p50 < 8'd80) &&
        (highlight_x32 <= {1'b0, total_ext}) &&
        (clip_x64 <= total_ext26);
    wire scene_low_contrast = (percentile_range < 8'd64) &&
        (clip_x64 <= total_ext26);
    wire [2:0] classified_scene = scene_backlight ? SCENE_BACKLIGHT :
        scene_bright ? SCENE_BRIGHT :
        scene_dark ? SCENE_DARK :
        scene_low_contrast ? SCENE_LOWCONTR : SCENE_NORMAL;

    function [8:0] scene_target_strength;
        input [2:0] mode;
        begin
            case (mode)
                SCENE_DARK,
                SCENE_BACKLIGHT,
                SCENE_LOWCONTR:
                    scene_target_strength = MAX_STRENGTH_Q8;
                SCENE_BRIGHT:
                    scene_target_strength = (MAX_STRENGTH_Q8 * 3) >> 2;
                default:
                    scene_target_strength = 9'd0;
            endcase
        end
    endfunction

    wire [8:0] target_strength = scene_target_strength(scene_mode);
    wire [8:0] strength_delta_up = target_strength - strength_q8;
    wire [8:0] strength_delta_down = strength_q8 - target_strength;
    wire [8:0] smooth_step_up = (strength_delta_up < 9'd8) ? 9'd1 :
        (strength_delta_up >> 3);
    wire [8:0] smooth_step_down = (strength_delta_down < 9'd8) ? 9'd1 :
        (strength_delta_down >> 3);
    wire [8:0] limited_step_up = (smooth_step_up > MAX_STEP_Q8) ?
        MAX_STEP_Q8 : smooth_step_up;
    wire [8:0] limited_step_down = (smooth_step_down > MAX_STEP_Q8) ?
        MAX_STEP_Q8 : smooth_step_down;
    wire unused_stats = ^{p10, dark_count};

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            scene_mode <= SCENE_NORMAL;
            scene_candidate <= SCENE_NORMAL;
            confirm_count <= 4'd0;
            strength_q8 <= 9'd0;
        end else if (stats_valid && sample_total != 20'd0) begin
            if (classified_scene == scene_mode) begin
                scene_candidate <= classified_scene;
                confirm_count <= 4'd0;
            end else if (classified_scene != scene_candidate) begin
                scene_candidate <= classified_scene;
                confirm_count <= 4'd1;
            end else if (confirm_count >= CONFIRM_FRAMES - 1) begin
                scene_mode <= classified_scene;
                confirm_count <= 4'd0;
            end else begin
                confirm_count <= confirm_count + 1'b1;
            end

            if (target_strength > strength_q8) begin
                if (strength_q8 + limited_step_up >= target_strength)
                    strength_q8 <= target_strength;
                else
                    strength_q8 <= strength_q8 + limited_step_up;
            end else if (target_strength < strength_q8) begin
                if (strength_q8 <= target_strength + limited_step_down)
                    strength_q8 <= target_strength;
                else
                    strength_q8 <= strength_q8 - limited_step_down;
            end
        end
    end
endmodule

// Five monotonic 17-point curves with Q8 mixing. Scene and strength are
// latched at frame start; a mode transition therefore cannot create a line
// seam. The detail reference travels through the same three-stage pipeline.
module isp_tone_mapper_17pt (
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    input  wire [7:0] cb_in,
    input  wire [7:0] cr_in,
    input  wire [7:0] detail_center_in,
    input  wire [7:0] detail_blur_in,
    input  wire       kernel_valid_in,
    input  wire [2:0] scene_mode,
    input  wire [8:0] strength_q8,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out,
    output reg  [7:0] detail_center_out,
    output reg  [7:0] detail_blur_out,
    output reg        kernel_valid_out
);
    localparam [2:0] SCENE_NORMAL    = 3'd0;
    localparam [2:0] SCENE_DARK      = 3'd1;
    localparam [2:0] SCENE_BRIGHT    = 3'd2;
    localparam [2:0] SCENE_BACKLIGHT = 3'd3;
    localparam [2:0] SCENE_LOWCONTR  = 3'd4;

    reg       vs_in_d;
    reg [2:0] scene_mode_active;
    reg [8:0] strength_active;
    wire frame_start = vs_in && !vs_in_d;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_in_d <= 1'b0;
            scene_mode_active <= SCENE_NORMAL;
            strength_active <= 9'd0;
        end else begin
            vs_in_d <= vs_in;
            if (frame_start) begin
                scene_mode_active <= scene_mode;
                strength_active <= strength_q8;
            end
        end
    end

    function [7:0] tone_anchor;
        input [2:0] mode;
        input [4:0] index;
        begin
            case (mode)
                SCENE_DARK: begin
                    case (index)
                        5'd0: tone_anchor=8'd0;   5'd1: tone_anchor=8'd18;
                        5'd2: tone_anchor=8'd38;  5'd3: tone_anchor=8'd58;
                        5'd4: tone_anchor=8'd78;  5'd5: tone_anchor=8'd98;
                        5'd6: tone_anchor=8'd117; 5'd7: tone_anchor=8'd136;
                        5'd8: tone_anchor=8'd154; 5'd9: tone_anchor=8'd171;
                        5'd10: tone_anchor=8'd188; 5'd11: tone_anchor=8'd204;
                        5'd12: tone_anchor=8'd219; 5'd13: tone_anchor=8'd224;
                        5'd14: tone_anchor=8'd232; 5'd15: tone_anchor=8'd240;
                        default: tone_anchor=8'd255;
                    endcase
                end
                SCENE_BRIGHT: begin
                    case (index)
                        5'd0: tone_anchor=8'd0;   5'd1: tone_anchor=8'd14;
                        5'd2: tone_anchor=8'd28;  5'd3: tone_anchor=8'd42;
                        5'd4: tone_anchor=8'd56;  5'd5: tone_anchor=8'd70;
                        5'd6: tone_anchor=8'd84;  5'd7: tone_anchor=8'd98;
                        5'd8: tone_anchor=8'd112; 5'd9: tone_anchor=8'd126;
                        5'd10: tone_anchor=8'd140; 5'd11: tone_anchor=8'd154;
                        5'd12: tone_anchor=8'd168; 5'd13: tone_anchor=8'd182;
                        5'd14: tone_anchor=8'd198; 5'd15: tone_anchor=8'd222;
                        default: tone_anchor=8'd255;
                    endcase
                end
                SCENE_BACKLIGHT: begin
                    case (index)
                        5'd0: tone_anchor=8'd0;   5'd1: tone_anchor=8'd18;
                        5'd2: tone_anchor=8'd38;  5'd3: tone_anchor=8'd58;
                        5'd4: tone_anchor=8'd78;  5'd5: tone_anchor=8'd98;
                        5'd6: tone_anchor=8'd117; 5'd7: tone_anchor=8'd136;
                        5'd8: tone_anchor=8'd153; 5'd9: tone_anchor=8'd169;
                        5'd10: tone_anchor=8'd184; 5'd11: tone_anchor=8'd198;
                        5'd12: tone_anchor=8'd211; 5'd13: tone_anchor=8'd220;
                        5'd14: tone_anchor=8'd228; 5'd15: tone_anchor=8'd240;
                        default: tone_anchor=8'd255;
                    endcase
                end
                SCENE_LOWCONTR: begin
                    case (index)
                        5'd0: tone_anchor=8'd0;   5'd1: tone_anchor=8'd8;
                        5'd2: tone_anchor=8'd20;  5'd3: tone_anchor=8'd34;
                        5'd4: tone_anchor=8'd50;  5'd5: tone_anchor=8'd68;
                        5'd6: tone_anchor=8'd88;  5'd7: tone_anchor=8'd109;
                        5'd8: tone_anchor=8'd128; 5'd9: tone_anchor=8'd147;
                        5'd10: tone_anchor=8'd168; 5'd11: tone_anchor=8'd188;
                        5'd12: tone_anchor=8'd206; 5'd13: tone_anchor=8'd222;
                        5'd14: tone_anchor=8'd232; 5'd15: tone_anchor=8'd240;
                        default: tone_anchor=8'd255;
                    endcase
                end
                default: begin
                    case (index)
                        5'd0: tone_anchor=8'd0;   5'd1: tone_anchor=8'd16;
                        5'd2: tone_anchor=8'd32;  5'd3: tone_anchor=8'd48;
                        5'd4: tone_anchor=8'd64;  5'd5: tone_anchor=8'd80;
                        5'd6: tone_anchor=8'd96;  5'd7: tone_anchor=8'd112;
                        5'd8: tone_anchor=8'd128; 5'd9: tone_anchor=8'd144;
                        5'd10: tone_anchor=8'd160; 5'd11: tone_anchor=8'd176;
                        5'd12: tone_anchor=8'd192; 5'd13: tone_anchor=8'd208;
                        5'd14: tone_anchor=8'd224; 5'd15: tone_anchor=8'd240;
                        default: tone_anchor=8'd255;
                    endcase
                end
            endcase
        end
    endfunction

    wire [4:0] lut_index = {1'b0, y_in[7:4]};
    wire [4:0] lut_next_index = lut_index + 1'b1;
    wire [7:0] lut_base = tone_anchor(scene_mode_active, lut_index);
    wire [7:0] lut_next = tone_anchor(scene_mode_active, lut_next_index);

    reg [7:0] base_d1;
    reg [7:0] delta_d1;
    reg [3:0] fraction_d1;
    reg [7:0] original_d1;
    reg [8:0] strength_d1;
    reg [7:0] cb_d1, cr_d1;
    reg [7:0] detail_center_d1, detail_blur_d1;
    reg       kernel_d1, vs_d1, de_d1;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            base_d1 <= 8'd0;
            delta_d1 <= 8'd0;
            fraction_d1 <= 4'd0;
            original_d1 <= 8'd0;
            strength_d1 <= 9'd0;
            cb_d1 <= 8'd128;
            cr_d1 <= 8'd128;
            detail_center_d1 <= 8'd0;
            detail_blur_d1 <= 8'd0;
            kernel_d1 <= 1'b0;
            vs_d1 <= 1'b0;
            de_d1 <= 1'b0;
        end else begin
            base_d1 <= lut_base;
            delta_d1 <= lut_next - lut_base;
            fraction_d1 <= y_in[3:0];
            original_d1 <= y_in;
            strength_d1 <= strength_active;
            cb_d1 <= cb_in;
            cr_d1 <= cr_in;
            detail_center_d1 <= detail_center_in;
            detail_blur_d1 <= detail_blur_in;
            kernel_d1 <= kernel_valid_in;
            vs_d1 <= vs_in;
            de_d1 <= de_in;
        end
    end

    reg [11:0] interpolation_d2;
    reg [7:0] base_d2;
    reg [7:0] original_d2;
    reg [8:0] strength_d2;
    reg [7:0] cb_d2, cr_d2;
    reg [7:0] detail_center_d2, detail_blur_d2;
    reg       kernel_d2, vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            interpolation_d2 <= 12'd0;
            base_d2 <= 8'd0;
            original_d2 <= 8'd0;
            strength_d2 <= 9'd0;
            cb_d2 <= 8'd128;
            cr_d2 <= 8'd128;
            detail_center_d2 <= 8'd0;
            detail_blur_d2 <= 8'd0;
            kernel_d2 <= 1'b0;
            vs_d2 <= 1'b0;
            de_d2 <= 1'b0;
        end else begin
            interpolation_d2 <= delta_d1 * fraction_d1;
            base_d2 <= base_d1;
            original_d2 <= original_d1;
            strength_d2 <= strength_d1;
            cb_d2 <= cb_d1;
            cr_d2 <= cr_d1;
            detail_center_d2 <= detail_center_d1;
            detail_blur_d2 <= detail_blur_d1;
            kernel_d2 <= kernel_d1;
            vs_d2 <= vs_d1;
            de_d2 <= de_d1;
        end
    end

    wire [8:0] interpolated_curve = {1'b0, base_d2} +
        (({1'b0, interpolation_d2} + 13'd8) >> 4);
    wire [7:0] protected_curve = (original_d2 == 8'd255) ? 8'd255 :
        (((original_d2 >= 8'd248) &&
         (interpolated_curve[7:0] > original_d2)) ?
        original_d2 : interpolated_curve[7:0]);
    wire curve_increases = protected_curve >= original_d2;
    wire [7:0] curve_difference = curve_increases ?
        (protected_curve - original_d2) :
        (original_d2 - protected_curve);
    wire [16:0] mix_product = curve_difference * strength_d2;
    wire [8:0] mix_delta = (mix_product + 17'd128) >> 8;
    wire [9:0] mixed_sum = {2'd0, original_d2} + {1'b0, mix_delta};
    wire [7:0] mixed_luma = curve_increases ?
        ((mixed_sum > 10'd255) ? 8'd255 : mixed_sum[7:0]) :
        (original_d2 - mix_delta[7:0]);

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out <= 1'b0;
            de_out <= 1'b0;
            y_out <= 8'd0;
            cb_out <= 8'd128;
            cr_out <= 8'd128;
            detail_center_out <= 8'd0;
            detail_blur_out <= 8'd0;
            kernel_valid_out <= 1'b0;
        end else begin
            vs_out <= vs_d2;
            de_out <= de_d2;
            kernel_valid_out <= de_d2 && kernel_d2;
            if (de_d2) begin
                y_out <= mixed_luma;
                cb_out <= cb_d2;
                cr_out <= cr_d2;
                detail_center_out <= detail_center_d2;
                detail_blur_out <= detail_blur_d2;
            end else begin
                y_out <= 8'd0;
                cb_out <= 8'd128;
                cr_out <= 8'd128;
                detail_center_out <= 8'd0;
                detail_blur_out <= 8'd0;
            end
        end
    end
endmodule

// Final limited unsharp stage. Positive and negative detail have independent
// limits; near-white and very dark pixels are protected to avoid halos and
// amplification of the sensor floor.
module isp_detail_enhance #(
    parameter integer ENABLE = 1,
    parameter integer NOISE_GATE = 6,
    parameter integer LIMIT_POS = 6,
    parameter integer LIMIT_NEG = 10
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    input  wire [7:0] cb_in,
    input  wire [7:0] cr_in,
    input  wire [7:0] center_y,
    input  wire [7:0] blur_y,
    input  wire       kernel_valid,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out
);
    wire detail_positive = center_y >= blur_y;
    wire [7:0] detail_abs = detail_positive ?
        (center_y - blur_y) : (blur_y - center_y);
    wire detail_enabled = (ENABLE != 0) && kernel_valid &&
        (y_in >= 8'd16) && (y_in < 8'd240) &&
        (detail_abs > NOISE_GATE);
    wire [8:0] detail_after_gate = detail_abs - NOISE_GATE;
    wire [8:0] boost_pos = (detail_after_gate > LIMIT_POS) ?
        LIMIT_POS : detail_after_gate;
    wire [8:0] boost_neg = (detail_after_gate > LIMIT_NEG) ?
        LIMIT_NEG : detail_after_gate;
    wire [8:0] positive_sum = {1'b0, y_in} + boost_pos;
    wire [7:0] enhanced_positive = (positive_sum > 9'd255) ?
        8'd255 : positive_sum[7:0];
    wire [7:0] enhanced_negative = (y_in < boost_neg) ?
        8'd0 : (y_in - boost_neg[7:0]);
    wire [7:0] enhanced_luma = !detail_enabled ? y_in :
        (detail_positive ? enhanced_positive : enhanced_negative);

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out <= 1'b0;
            de_out <= 1'b0;
            y_out <= 8'd0;
            cb_out <= 8'd128;
            cr_out <= 8'd128;
        end else begin
            vs_out <= vs_in;
            de_out <= de_in;
            if (de_in) begin
                y_out <= enhanced_luma;
                cb_out <= cb_in;
                cr_out <= cr_in;
            end else begin
                y_out <= 8'd0;
                cb_out <= 8'd128;
                cr_out <= 8'd128;
            end
        end
    end
endmodule

// Three monotonic 17-point S-curve LUTs are selected from the previous
// complete frame. Selection has hysteresis, and a high clipped-pixel ratio
// always takes priority over shadow lifting to follow the "do not overexpose"
// policy. Linear interpolation keeps the ROM compact and the output smooth.
module adaptive_scurve_gamma #(
    parameter integer MIN_FRAME_PIXELS = 800000
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    input  wire [7:0] cb_in,
    input  wire [7:0] cr_in,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out
);
    localparam [1:0] MODE_NORMAL = 2'd0;
    localparam [1:0] MODE_DARK   = 2'd1;
    localparam [1:0] MODE_BRIGHT = 2'd2;

    reg        vs_in_d;
    reg [31:0] frame_luma_sum;
    reg [19:0] frame_pixel_count;
    reg [19:0] frame_highlight_count;
    reg [1:0]  gamma_mode;

    wire frame_start = vs_in && !vs_in_d;
    wire [31:0] pixel_count_ext = {12'd0, frame_pixel_count};
    wire [31:0] average_80_limit =
        (pixel_count_ext << 6) + (pixel_count_ext << 4);
    wire [31:0] average_104_limit =
        (pixel_count_ext << 6) + (pixel_count_ext << 5) +
        (pixel_count_ext << 3);
    wire [31:0] average_152_limit =
        (pixel_count_ext << 7) + (pixel_count_ext << 4) +
        (pixel_count_ext << 3);
    wire [31:0] average_176_limit =
        (pixel_count_ext << 7) + (pixel_count_ext << 5) +
        (pixel_count_ext << 4);

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_in_d <= 1'b0;
            frame_luma_sum <= 32'd0;
            frame_pixel_count <= 20'd0;
            frame_highlight_count <= 20'd0;
            gamma_mode <= MODE_NORMAL;
        end else begin
            vs_in_d <= vs_in;

            if (de_in) begin
                frame_luma_sum <= frame_luma_sum + {24'd0, y_in};
                frame_pixel_count <= frame_pixel_count + 1'b1;
                if (y_in >= 8'd240)
                    frame_highlight_count <= frame_highlight_count + 1'b1;
            end

            if (frame_start) begin
                if (frame_pixel_count >= MIN_FRAME_PIXELS) begin
                    case (gamma_mode)
                        MODE_DARK: begin
                            if ((frame_highlight_count >
                                 (frame_pixel_count >> 4)) ||
                                (frame_luma_sum > average_176_limit))
                                gamma_mode <= MODE_BRIGHT;
                            else if (frame_luma_sum > average_104_limit)
                                gamma_mode <= MODE_NORMAL;
                        end
                        MODE_BRIGHT: begin
                            if ((frame_highlight_count <=
                                 (frame_pixel_count >> 4)) &&
                                (frame_luma_sum < average_152_limit)) begin
                                if (frame_luma_sum < average_80_limit)
                                    gamma_mode <= MODE_DARK;
                                else
                                    gamma_mode <= MODE_NORMAL;
                            end
                        end
                        default: begin
                            if ((frame_highlight_count >
                                 (frame_pixel_count >> 3)) ||
                                (frame_luma_sum > average_176_limit))
                                gamma_mode <= MODE_BRIGHT;
                            else if ((frame_luma_sum < average_80_limit) &&
                                     (frame_highlight_count <=
                                      (frame_pixel_count >> 5)))
                                gamma_mode <= MODE_DARK;
                        end
                    endcase
                end
                frame_luma_sum <= 32'd0;
                frame_pixel_count <= 20'd0;
                frame_highlight_count <= 20'd0;
            end
        end
    end

    function [7:0] scurve_anchor;
        input [1:0] mode;
        input [4:0] index;
        begin
            case (mode)
                MODE_DARK: begin
                    case (index)
                        5'd0:  scurve_anchor = 8'd0;
                        5'd1:  scurve_anchor = 8'd32;
                        5'd2:  scurve_anchor = 8'd54;
                        5'd3:  scurve_anchor = 8'd72;
                        5'd4:  scurve_anchor = 8'd90;
                        5'd5:  scurve_anchor = 8'd106;
                        5'd6:  scurve_anchor = 8'd122;
                        5'd7:  scurve_anchor = 8'd137;
                        5'd8:  scurve_anchor = 8'd151;
                        5'd9:  scurve_anchor = 8'd165;
                        5'd10: scurve_anchor = 8'd179;
                        5'd11: scurve_anchor = 8'd192;
                        5'd12: scurve_anchor = 8'd205;
                        5'd13: scurve_anchor = 8'd218;
                        5'd14: scurve_anchor = 8'd231;
                        5'd15: scurve_anchor = 8'd243;
                        default: scurve_anchor = 8'd255;
                    endcase
                end
                MODE_BRIGHT: begin
                    case (index)
                        5'd0:  scurve_anchor = 8'd0;
                        5'd1:  scurve_anchor = 8'd8;
                        5'd2:  scurve_anchor = 8'd19;
                        5'd3:  scurve_anchor = 8'd31;
                        5'd4:  scurve_anchor = 8'd45;
                        5'd5:  scurve_anchor = 8'd60;
                        5'd6:  scurve_anchor = 8'd76;
                        5'd7:  scurve_anchor = 8'd92;
                        5'd8:  scurve_anchor = 8'd109;
                        5'd9:  scurve_anchor = 8'd126;
                        5'd10: scurve_anchor = 8'd144;
                        5'd11: scurve_anchor = 8'd162;
                        5'd12: scurve_anchor = 8'd180;
                        5'd13: scurve_anchor = 8'd198;
                        5'd14: scurve_anchor = 8'd217;
                        5'd15: scurve_anchor = 8'd236;
                        default: scurve_anchor = 8'd255;
                    endcase
                end
                default: begin
                    case (index)
                        5'd0:  scurve_anchor = 8'd0;
                        5'd1:  scurve_anchor = 8'd12;
                        5'd2:  scurve_anchor = 8'd26;
                        5'd3:  scurve_anchor = 8'd41;
                        5'd4:  scurve_anchor = 8'd57;
                        5'd5:  scurve_anchor = 8'd74;
                        5'd6:  scurve_anchor = 8'd91;
                        5'd7:  scurve_anchor = 8'd109;
                        5'd8:  scurve_anchor = 8'd128;
                        5'd9:  scurve_anchor = 8'd147;
                        5'd10: scurve_anchor = 8'd165;
                        5'd11: scurve_anchor = 8'd182;
                        5'd12: scurve_anchor = 8'd199;
                        5'd13: scurve_anchor = 8'd215;
                        5'd14: scurve_anchor = 8'd230;
                        5'd15: scurve_anchor = 8'd244;
                        default: scurve_anchor = 8'd255;
                    endcase
                end
            endcase
        end
    endfunction

    wire [4:0] lut_index = {1'b0, y_in[7:4]};
    wire [4:0] lut_next_index = lut_index + 1'b1;
    wire [7:0] lut_base = scurve_anchor(gamma_mode, lut_index);
    wire [7:0] lut_next = scurve_anchor(gamma_mode, lut_next_index);
    wire [7:0] lut_delta = lut_next - lut_base;

    reg [7:0] lut_base_d1;
    reg [7:0] lut_delta_d1;
    reg [3:0] lut_fraction_d1;
    reg       full_white_d1;
    reg [7:0] cb_d1;
    reg [7:0] cr_d1;
    reg       vs_d1;
    reg       de_d1;

    reg [11:0] interpolation_d2;
    reg [7:0]  lut_base_d2;
    reg        full_white_d2;
    reg [7:0]  cb_d2;
    reg [7:0]  cr_d2;
    reg        vs_d2;
    reg        de_d2;

    wire [12:0] interpolation_rounded =
        {1'b0, interpolation_d2} + 13'd8;
    wire [8:0] interpolated_y =
        {1'b0, lut_base_d2} + {1'b0, interpolation_rounded[11:4]};

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            lut_base_d1 <= 8'd0;
            lut_delta_d1 <= 8'd0;
            lut_fraction_d1 <= 4'd0;
            full_white_d1 <= 1'b0;
            cb_d1 <= 8'd128;
            cr_d1 <= 8'd128;
            vs_d1 <= 1'b0;
            de_d1 <= 1'b0;
        end else begin
            lut_base_d1 <= lut_base;
            lut_delta_d1 <= lut_delta;
            lut_fraction_d1 <= y_in[3:0];
            full_white_d1 <= (y_in == 8'hff);
            cb_d1 <= cb_in;
            cr_d1 <= cr_in;
            vs_d1 <= vs_in;
            de_d1 <= de_in;
        end
    end

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            interpolation_d2 <= 12'd0;
            lut_base_d2 <= 8'd0;
            full_white_d2 <= 1'b0;
            cb_d2 <= 8'd128;
            cr_d2 <= 8'd128;
            vs_d2 <= 1'b0;
            de_d2 <= 1'b0;
        end else begin
            interpolation_d2 <= lut_delta_d1 * lut_fraction_d1;
            lut_base_d2 <= lut_base_d1;
            full_white_d2 <= full_white_d1;
            cb_d2 <= cb_d1;
            cr_d2 <= cr_d1;
            vs_d2 <= vs_d1;
            de_d2 <= de_d1;
        end
    end

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_out <= 8'd0;
            cb_out <= 8'd128;
            cr_out <= 8'd128;
            vs_out <= 1'b0;
            de_out <= 1'b0;
        end else begin
            y_out <= full_white_d2 ? 8'hff : interpolated_y[7:0];
            cb_out <= cb_d2;
            cr_out <= cr_d2;
            vs_out <= vs_d2;
            de_out <= de_d2;
        end
    end
endmodule

// Camera cleanup used by the raw OV5640 paths. Y passes unchanged while the
// 3x3 kernel filters only Cb/Cr. No exposure, Gamma or white-balance control
// is present, and the first two rows/columns bypass the incomplete kernel.
module camera_chroma_denoise #(
    parameter integer IMG_WIDTH = 1280
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [15:0] data_in,
    output wire        vs_out,
    output wire        de_out,
    output wire [15:0] data_out
);
    // rgb2ycbcr follows the original camera convention: logical R is low.
    wire [15:0] converter_rgb565 = {
        data_in[4:0], data_in[10:5], data_in[15:11]
    };

    wire       vs_ycbcr;
    wire       de_ycbcr;
    wire [7:0] y_ycbcr;
    wire [7:0] cb_ycbcr;
    wire [7:0] cr_ycbcr;
    wire       vs_filtered;
    wire       de_filtered;
    wire [7:0] y_filtered;
    wire [7:0] cb_filtered;
    wire [7:0] cr_filtered;

    rgb2ycbcr u_camera_rgb2ycbcr (
        .pclk(pclk), .rst_n(rst_n), .vs_in(vs_in), .de_in(de_in),
        .rgb_in(converter_rgb565), .vs_out(vs_ycbcr),
        .de_out(de_ycbcr), .y_out(y_ycbcr),
        .cb_out(cb_ycbcr), .cr_out(cr_ycbcr)
    );

    y_gaussian_filter #(
        .IMG_WIDTH(IMG_WIDTH),
        .FILTER_LUMA(0),
        .BYPASS_BORDER(1)
    ) u_camera_chroma_filter (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_ycbcr), .de_in(de_ycbcr),
        .y_in(y_ycbcr), .cb_in(cb_ycbcr), .cr_in(cr_ycbcr),
        .vs_out(vs_filtered), .de_out(de_filtered),
        .y_out(y_filtered), .cb_out(cb_filtered), .cr_out(cr_filtered)
    );

    ycbcr2rgb u_camera_ycbcr2rgb (
        .pclk(pclk), .rst_n(rst_n),
        .vs_in(vs_filtered), .de_in(de_filtered),
        .y_in(y_filtered), .cb_in(cb_filtered), .cr_in(cr_filtered),
        .vs_out(vs_out), .de_out(de_out), .rgb_out(data_out)
    );
endmodule

// Small frame-rate chroma servo for fixed cameras. It only uses pixels that
// are bright enough to be useful as a white/gray reference and not strongly
// saturated. The correction is limited and updated at frame boundaries, so a
// colored object cannot create a visible per-line color jump.
module adaptive_chroma_balance #(
    parameter integer MIN_NEUTRAL_SAMPLES = 4096,
    parameter integer OFFSET_LIMIT = 8
)(
    input  wire       pclk,
    input  wire       rst_n,
    input  wire       vs_in,
    input  wire       de_in,
    input  wire [7:0] y_in,
    input  wire [7:0] cb_in,
    input  wire [7:0] cr_in,
    output reg        vs_out,
    output reg        de_out,
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out
);

    reg               vs_d;
    reg [19:0]        neutral_count;
    reg [19:0]        cb_high_count;
    reg [19:0]        cb_low_count;
    reg [19:0]        cr_high_count;
    reg [19:0]        cr_low_count;
    reg signed [5:0] cb_offset;
    reg signed [5:0] cr_offset;
    reg signed [5:0] cb_offset_frame;
    reg signed [5:0] cr_offset_frame;

    localparam signed [5:0] OFFSET_LIMIT_S = OFFSET_LIMIT;

    wire frame_start = vs_in && !vs_d;

    wire signed [9:0] cb_adjusted_signed =
        $signed({2'b00, cb_in}) + {{4{cb_offset_frame[5]}}, cb_offset_frame};
    wire signed [9:0] cr_adjusted_signed =
        $signed({2'b00, cr_in}) + {{4{cr_offset_frame[5]}}, cr_offset_frame};

    function [7:0] clamp_chroma;
        input signed [9:0] value;
        begin
            if (value < 10'sd0)
                clamp_chroma = 8'd0;
            else if (value > 10'sd255)
                clamp_chroma = 8'd255;
            else
                clamp_chroma = value[7:0];
        end
    endfunction

    wire [7:0] cb_adjusted = clamp_chroma(cb_adjusted_signed);
    wire [7:0] cr_adjusted = clamp_chroma(cr_adjusted_signed);

    wire [7:0] cb_distance = (cb_adjusted >= 8'd128) ?
        (cb_adjusted - 8'd128) : (8'd128 - cb_adjusted);
    wire [7:0] cr_distance = (cr_adjusted >= 8'd128) ?
        (cr_adjusted - 8'd128) : (8'd128 - cr_adjusted);
    wire [8:0] neutral_distance =
        {1'b0, cb_distance} + {1'b0, cr_distance};

    // Keep the reference set tight. Low-light sensor noise and weakly colored
    // objects must not steer the two cameras toward different white points.
    wire neutral_candidate = de_in &&
                             (y_in >= 8'd96) && (y_in <= 8'd224) &&
                             (cb_adjusted >= 8'd112) &&
                             (cb_adjusted <= 8'd144) &&
                             (cr_adjusted >= 8'd112) &&
                             (cr_adjusted <= 8'd144) &&
                             (neutral_distance <= 9'd20);
    wire cb_high_vote = neutral_candidate && (cb_adjusted > 8'd129);
    wire cb_low_vote  = neutral_candidate && (cb_adjusted < 8'd127);
    wire cr_high_vote = neutral_candidate && (cr_adjusted > 8'd129);
    wire cr_low_vote  = neutral_candidate && (cr_adjusted < 8'd127);

    wire [20:0] neutral_count_ext = {1'b0, neutral_count};
    wire [20:0] vote_margin       = neutral_count_ext >> 3;
    wire [20:0] cb_high_ext       = {1'b0, cb_high_count};
    wire [20:0] cb_low_ext        = {1'b0, cb_low_count};
    wire [20:0] cr_high_ext       = {1'b0, cr_high_count};
    wire [20:0] cr_low_ext        = {1'b0, cr_low_count};

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_d           <= 1'b0;
            neutral_count  <= 20'd0;
            cb_high_count  <= 20'd0;
            cb_low_count   <= 20'd0;
            cr_high_count  <= 20'd0;
            cr_low_count   <= 20'd0;
            cb_offset      <= 6'sd0;
            cr_offset      <= 6'sd0;
            cb_offset_frame <= 6'sd0;
            cr_offset_frame <= 6'sd0;
        end else begin
            vs_d <= vs_in;

            if (frame_start) begin
                // Keep one correction value for an entire frame. The value
                // calculated below becomes active on the following frame.
                cb_offset_frame <= cb_offset;
                cr_offset_frame <= cr_offset;
                if (neutral_count >= MIN_NEUTRAL_SAMPLES) begin
                    if (cb_high_ext > (cb_low_ext + vote_margin)) begin
                        if (cb_offset > -OFFSET_LIMIT_S)
                            cb_offset <= cb_offset - 6'sd1;
                    end else if (cb_low_ext > (cb_high_ext + vote_margin)) begin
                        if (cb_offset < OFFSET_LIMIT_S)
                            cb_offset <= cb_offset + 6'sd1;
                    end

                    if (cr_high_ext > (cr_low_ext + vote_margin)) begin
                        if (cr_offset > -OFFSET_LIMIT_S)
                            cr_offset <= cr_offset - 6'sd1;
                    end else if (cr_low_ext > (cr_high_ext + vote_margin)) begin
                        if (cr_offset < OFFSET_LIMIT_S)
                            cr_offset <= cr_offset + 6'sd1;
                    end
                end

                neutral_count <= 20'd0;
                cb_high_count <= 20'd0;
                cb_low_count  <= 20'd0;
                cr_high_count <= 20'd0;
                cr_low_count  <= 20'd0;
            end else if (neutral_candidate) begin
                neutral_count <= neutral_count + 20'd1;
                if (cb_high_vote)
                    cb_high_count <= cb_high_count + 20'd1;
                if (cb_low_vote)
                    cb_low_count <= cb_low_count + 20'd1;
                if (cr_high_vote)
                    cr_high_count <= cr_high_count + 20'd1;
                if (cr_low_vote)
                    cr_low_count <= cr_low_count + 20'd1;
            end
        end
    end

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out <= 1'b0;
            de_out <= 1'b0;
            y_out  <= 8'd0;
            cb_out <= 8'd128;
            cr_out <= 8'd128;
        end else begin
            vs_out <= vs_in;
            de_out <= de_in;
            if (de_in) begin
                y_out  <= y_in;
                cb_out <= cb_adjusted;
                cr_out <= cr_adjusted;
            end else begin
                y_out  <= 8'd0;
                cb_out <= 8'd128;
                cr_out <= 8'd128;
            end
        end
    end

endmodule

// Fixed-point per-camera white balance. The OV5640 camera path used by the
// existing rgb2ycbcr block carries logical R in [4:0] and logical B in [15:11].
// Gains are unsigned Q8 and the output keeps the same BGR565 wire layout.
module rgb565_white_balance #(
    parameter [9:0] R_GAIN_Q8 = 10'd256,
    parameter [9:0] G_GAIN_Q8 = 10'd256,
    parameter [9:0] B_GAIN_Q8 = 10'd256
)(
    input  wire        pclk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [15:0] rgb_in,
    output reg         vs_out,
    output reg         de_out,
    output reg  [15:0] rgb_out
);

    wire [7:0] r_in = {rgb_in[4:0], rgb_in[2:0]};
    wire [7:0] g_in = {rgb_in[10:5], rgb_in[6:5]};
    wire [7:0] b_in = {rgb_in[15:11], rgb_in[13:11]};

    wire [17:0] r_scaled_q8 = r_in * R_GAIN_Q8;
    wire [17:0] g_scaled_q8 = g_in * G_GAIN_Q8;
    wire [17:0] b_scaled_q8 = b_in * B_GAIN_Q8;

    function [7:0] clamp_q8_gain;
        input [17:0] scaled_value;
        begin
            if (scaled_value >= 18'd65280)
                clamp_q8_gain = 8'd255;
            else
                clamp_q8_gain = scaled_value[15:8];
        end
    endfunction

    wire [7:0] r_balanced = clamp_q8_gain(r_scaled_q8);
    wire [7:0] g_balanced = clamp_q8_gain(g_scaled_q8);
    wire [7:0] b_balanced = clamp_q8_gain(b_scaled_q8);

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out  <= 1'b0;
            de_out  <= 1'b0;
            rgb_out <= 16'd0;
        end else begin
            vs_out <= vs_in;
            de_out <= de_in;
            if (de_in)
                rgb_out <= {b_balanced[7:3], g_balanced[7:2], r_balanced[7:3]};
            else
                rgb_out <= 16'd0;
        end
    end

endmodule

// Frame-level luma controller. The gain is Q8, starts at unity, and is
// changed slowly so a new scene cannot create a visible line jump. Camera
// instances can additionally use a stronger backlight curve while HDMI keeps
// the original exposure-aware mapping.
module adaptive_luma_cdc #(
    parameter integer EXPOSURE_AWARE = 0,
    parameter integer BACKLIGHT_COMPENSATION = 0,
    parameter integer EXPOSURE_CONFIRM_FRAMES = 2
)(
    input  wire        pclk,
    input  wire        ctrl_clk,
    input  wire        rst_n,
    input  wire        vs_in,
    input  wire        de_in,
    input  wire [7:0]  y_in,
    input  wire [7:0]  cb_in,
    input  wire [7:0]  cr_in,
    output reg         vs_out,
    output reg         de_out,
    output reg  [7:0]  y_out,
    output reg  [7:0]  cb_out,
    output reg  [7:0]  cr_out
);

    localparam [1:0] EXPOSURE_NORMAL    = 2'd0;
    localparam [1:0] EXPOSURE_SHADOW    = 2'd1;
    localparam [1:0] EXPOSURE_HIGHLIGHT = 2'd2;
    localparam [1:0] EXPOSURE_MIXED     = 2'd3;

    // 1280 x 720 x 255 fits in 28 bits; the count fits in 20 bits.
    reg [27:0] frame_sum_pclk;
    reg [19:0] frame_count_pclk;
    reg [19:0] frame_shadow_count_pclk;
    reg [19:0] frame_highlight_count_pclk;
    reg [19:0] frame_clip_count_pclk;
    reg [27:0] stats_sum_bus_pclk;
    reg [19:0] stats_count_bus_pclk;
    reg [19:0] stats_shadow_bus_pclk;
    reg [19:0] stats_highlight_bus_pclk;
    reg [19:0] stats_clip_bus_pclk;
    reg        stats_toggle_pclk;
    reg        vs_edge_d_pclk;

    wire frame_start_pclk = vs_in && !vs_edge_d_pclk;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            frame_sum_pclk      <= 28'd0;
            frame_count_pclk    <= 20'd0;
            frame_shadow_count_pclk <= 20'd0;
            frame_highlight_count_pclk <= 20'd0;
            frame_clip_count_pclk <= 20'd0;
            stats_sum_bus_pclk  <= 28'd0;
            stats_count_bus_pclk<= 20'd0;
            stats_shadow_bus_pclk <= 20'd0;
            stats_highlight_bus_pclk <= 20'd0;
            stats_clip_bus_pclk <= 20'd0;
            stats_toggle_pclk   <= 1'b0;
            vs_edge_d_pclk      <= 1'b0;
        end else begin
            vs_edge_d_pclk <= vs_in;

            if (frame_start_pclk) begin
                if (frame_count_pclk != 20'd0) begin
                    stats_sum_bus_pclk   <= frame_sum_pclk;
                    stats_count_bus_pclk <= frame_count_pclk;
                    stats_shadow_bus_pclk <= frame_shadow_count_pclk;
                    stats_highlight_bus_pclk <= frame_highlight_count_pclk;
                    stats_clip_bus_pclk <= frame_clip_count_pclk;
                    stats_toggle_pclk    <= ~stats_toggle_pclk;
                end
                frame_sum_pclk   <= 28'd0;
                frame_count_pclk <= 20'd0;
                frame_shadow_count_pclk <= 20'd0;
                frame_highlight_count_pclk <= 20'd0;
                frame_clip_count_pclk <= 20'd0;
            end else if (de_in) begin
                frame_sum_pclk   <= frame_sum_pclk + {20'd0, y_in};
                frame_count_pclk <= frame_count_pclk + 20'd1;
                if (y_in < 8'd64)
                    frame_shadow_count_pclk <= frame_shadow_count_pclk + 20'd1;
                if (y_in >= 8'd208)
                    frame_highlight_count_pclk <= frame_highlight_count_pclk + 20'd1;
                if (y_in >= 8'd240)
                    frame_clip_count_pclk <= frame_clip_count_pclk + 20'd1;
            end
        end
    end

    // The data bus is held stable before the toggle and until the next frame.
    // Two register stages provide settling time before the toggle is consumed.
    (* ASYNC_REG = "TRUE" *) reg        stats_toggle_meta_ctrl;
    (* ASYNC_REG = "TRUE" *) reg        stats_toggle_sync_ctrl;
    reg        stats_toggle_seen_ctrl;
    reg [27:0] stats_sum_meta_ctrl;
    reg [27:0] stats_sum_sync_ctrl;
    reg [19:0] stats_count_meta_ctrl;
    reg [19:0] stats_count_sync_ctrl;
    reg [19:0] stats_shadow_meta_ctrl;
    reg [19:0] stats_shadow_sync_ctrl;
    reg [19:0] stats_highlight_meta_ctrl;
    reg [19:0] stats_highlight_sync_ctrl;
    reg [19:0] stats_clip_meta_ctrl;
    reg [19:0] stats_clip_sync_ctrl;
    reg [9:0]  gain_ctrl;
    reg [1:0]  exposure_mode_ctrl;
    reg [1:0]  exposure_candidate_ctrl;
    reg [3:0]  exposure_confirm_count_ctrl;
    reg        gain_toggle_ctrl;

    wire [27:0] count_ext_ctrl = {8'd0, stats_count_sync_ctrl};
    wire [27:0] dark_limit_ctrl = (count_ext_ctrl << 6) + (count_ext_ctrl << 3); // 72 * count
    wire [27:0] bright_limit_ctrl = (count_ext_ctrl << 7) + (count_ext_ctrl << 4); // 144 * count
    wire [27:0] exposure_dark_limit_ctrl =
        (count_ext_ctrl << 6) + (count_ext_ctrl << 5); // 96 * count
    wire [27:0] exposure_bright_limit_ctrl =
        (count_ext_ctrl << 7) + (count_ext_ctrl << 5); // 160 * count

    wire [24:0] count_ext25_ctrl = {5'd0, stats_count_sync_ctrl};
    wire [24:0] shadow_x2_ctrl =
        {4'd0, stats_shadow_sync_ctrl, 1'b0};
    wire [24:0] shadow_x4_ctrl =
        {3'd0, stats_shadow_sync_ctrl, 2'b0};
    wire [24:0] highlight_x4_ctrl =
        {3'd0, stats_highlight_sync_ctrl, 2'b0};
    wire [24:0] highlight_x16_ctrl =
        {1'd0, stats_highlight_sync_ctrl, 4'b0};
    wire [24:0] clip_x32_ctrl = {stats_clip_sync_ctrl, 5'b0};
    wire [25:0] count_ext26_ctrl = {6'd0, stats_count_sync_ctrl};
    wire [25:0] clip_x64_ctrl = {stats_clip_sync_ctrl, 6'b0};

    wire shadow_heavy_ctrl = shadow_x2_ctrl > count_ext25_ctrl;
    wire shadow_significant_ctrl = shadow_x4_ctrl > count_ext25_ctrl;
    wire highlight_heavy_ctrl = highlight_x4_ctrl > count_ext25_ctrl;
    wire highlight_present_ctrl = highlight_x16_ctrl > count_ext25_ctrl;
    wire clipped_many_ctrl = clip_x32_ctrl > count_ext25_ctrl;
    wire clipped_present_ctrl = clip_x64_ctrl >= count_ext26_ctrl;
    wire backlight_highlight_present_ctrl = highlight_present_ctrl ||
        ((BACKLIGHT_COMPENSATION != 0) && clipped_present_ctrl);
    wire [1:0] classified_exposure_ctrl =
        (shadow_significant_ctrl && backlight_highlight_present_ctrl) ?
            EXPOSURE_MIXED :
        (clipped_many_ctrl || highlight_heavy_ctrl ||
         (stats_sum_sync_ctrl > exposure_bright_limit_ctrl)) ?
            EXPOSURE_HIGHLIGHT :
        (shadow_heavy_ctrl ||
         (stats_sum_sync_ctrl < exposure_dark_limit_ctrl)) ?
            EXPOSURE_SHADOW : EXPOSURE_NORMAL;

    always @(posedge ctrl_clk or negedge rst_n) begin
        if (!rst_n) begin
            stats_toggle_meta_ctrl <= 1'b0;
            stats_toggle_sync_ctrl <= 1'b0;
            stats_toggle_seen_ctrl <= 1'b0;
            stats_sum_meta_ctrl    <= 28'd0;
            stats_sum_sync_ctrl    <= 28'd0;
            stats_count_meta_ctrl  <= 20'd0;
            stats_count_sync_ctrl  <= 20'd0;
            stats_shadow_meta_ctrl <= 20'd0;
            stats_shadow_sync_ctrl <= 20'd0;
            stats_highlight_meta_ctrl <= 20'd0;
            stats_highlight_sync_ctrl <= 20'd0;
            stats_clip_meta_ctrl   <= 20'd0;
            stats_clip_sync_ctrl   <= 20'd0;
            gain_ctrl              <= 10'd256;
            exposure_mode_ctrl     <= EXPOSURE_NORMAL;
            exposure_candidate_ctrl <= EXPOSURE_NORMAL;
            exposure_confirm_count_ctrl <= 4'd0;
            gain_toggle_ctrl       <= 1'b0;
        end else begin
            stats_toggle_meta_ctrl <= stats_toggle_pclk;
            stats_toggle_sync_ctrl <= stats_toggle_meta_ctrl;
            stats_sum_meta_ctrl    <= stats_sum_bus_pclk;
            stats_sum_sync_ctrl    <= stats_sum_meta_ctrl;
            stats_count_meta_ctrl  <= stats_count_bus_pclk;
            stats_count_sync_ctrl  <= stats_count_meta_ctrl;
            stats_shadow_meta_ctrl <= stats_shadow_bus_pclk;
            stats_shadow_sync_ctrl <= stats_shadow_meta_ctrl;
            stats_highlight_meta_ctrl <= stats_highlight_bus_pclk;
            stats_highlight_sync_ctrl <= stats_highlight_meta_ctrl;
            stats_clip_meta_ctrl   <= stats_clip_bus_pclk;
            stats_clip_sync_ctrl   <= stats_clip_meta_ctrl;

            if (stats_toggle_sync_ctrl != stats_toggle_seen_ctrl) begin
                stats_toggle_seen_ctrl <= stats_toggle_sync_ctrl;
                if (stats_count_sync_ctrl != 20'd0) begin
                    if (EXPOSURE_AWARE != 0) begin
                        // HDMI uses a longer confirmation window so one
                        // damaged or borderline frame cannot switch the
                        // piecewise curve and create visible pumping.
                        if (classified_exposure_ctrl == exposure_mode_ctrl) begin
                            exposure_candidate_ctrl <= classified_exposure_ctrl;
                            exposure_confirm_count_ctrl <= 4'd0;
                        end else if (classified_exposure_ctrl !=
                                     exposure_candidate_ctrl) begin
                            exposure_candidate_ctrl <= classified_exposure_ctrl;
                            exposure_confirm_count_ctrl <= 4'd1;
                        end else if (exposure_confirm_count_ctrl >=
                                     EXPOSURE_CONFIRM_FRAMES - 1) begin
                            exposure_mode_ctrl <= classified_exposure_ctrl;
                            exposure_confirm_count_ctrl <= 4'd0;
                        end else begin
                            exposure_confirm_count_ctrl <=
                                exposure_confirm_count_ctrl + 1'b1;
                        end

                        if (BACKLIGHT_COMPENSATION != 0) begin
                            // Camera path: never darken the complete frame in
                            // response to a lamp or bright sky. The camera
                            // curve handles highlight compression locally.
                            if (exposure_mode_ctrl == EXPOSURE_MIXED ||
                                exposure_mode_ctrl ==
                                EXPOSURE_HIGHLIGHT) begin
                                if (gain_ctrl > 10'd256)
                                    gain_ctrl <= gain_ctrl - 10'd2;
                                else if (gain_ctrl < 10'd256)
                                    gain_ctrl <= gain_ctrl + 10'd2;
                                else
                                    gain_ctrl <= 10'd256;
                            end else if (exposure_mode_ctrl ==
                                         EXPOSURE_SHADOW) begin
                                if (gain_ctrl >= 10'd270)
                                    gain_ctrl <= 10'd272;
                                else
                                    gain_ctrl <= gain_ctrl + 10'd2;
                            end else if (gain_ctrl > 10'd256) begin
                                if (gain_ctrl <= 10'd258)
                                    gain_ctrl <= 10'd256;
                                else
                                    gain_ctrl <= gain_ctrl - 10'd2;
                            end else if (gain_ctrl < 10'd256) begin
                                if (gain_ctrl >= 10'd254)
                                    gain_ctrl <= 10'd256;
                                else
                                    gain_ctrl <= gain_ctrl + 10'd2;
                            end
                        end else begin
                            // HDMI path: preserve the v4.8 gain behavior.
                            if (exposure_mode_ctrl == EXPOSURE_MIXED) begin
                                if (gain_ctrl > 10'd260)
                                    gain_ctrl <= gain_ctrl - 10'd4;
                                else if (gain_ctrl < 10'd252)
                                    gain_ctrl <= gain_ctrl + 10'd4;
                                else
                                    gain_ctrl <= 10'd256;
                            end else if (exposure_mode_ctrl ==
                                         EXPOSURE_HIGHLIGHT) begin
                                if (gain_ctrl <= 10'd250)
                                    gain_ctrl <= 10'd248;
                                else
                                    gain_ctrl <= gain_ctrl - 10'd2;
                            end else if (exposure_mode_ctrl ==
                                         EXPOSURE_SHADOW) begin
                                if (gain_ctrl >= 10'd300)
                                    gain_ctrl <= 10'd304;
                                else
                                    gain_ctrl <= gain_ctrl + 10'd4;
                            end else if (gain_ctrl > 10'd256) begin
                                if (gain_ctrl <= 10'd258)
                                    gain_ctrl <= 10'd256;
                                else
                                    gain_ctrl <= gain_ctrl - 10'd2;
                            end else if (gain_ctrl < 10'd256) begin
                                if (gain_ctrl >= 10'd254)
                                    gain_ctrl <= 10'd256;
                                else
                                    gain_ctrl <= gain_ctrl + 10'd2;
                            end
                        end
                    end else begin
                        exposure_mode_ctrl <= EXPOSURE_NORMAL;
                        exposure_candidate_ctrl <= EXPOSURE_NORMAL;
                        exposure_confirm_count_ctrl <= 4'd0;
                        if (stats_sum_sync_ctrl < dark_limit_ctrl) begin
                            if (gain_ctrl >= 10'd316)
                                gain_ctrl <= 10'd320;
                            else
                                gain_ctrl <= gain_ctrl + 10'd4;
                        end else if (stats_sum_sync_ctrl > bright_limit_ctrl) begin
                            if (gain_ctrl <= 10'd228)
                                gain_ctrl <= 10'd224;
                            else
                                gain_ctrl <= gain_ctrl - 10'd4;
                        end else if (gain_ctrl > 10'd256) begin
                            if (gain_ctrl <= 10'd258)
                                gain_ctrl <= 10'd256;
                            else
                                gain_ctrl <= gain_ctrl - 10'd2;
                        end else if (gain_ctrl < 10'd256) begin
                            if (gain_ctrl >= 10'd254)
                                gain_ctrl <= 10'd256;
                            else
                                gain_ctrl <= gain_ctrl + 10'd2;
                        end
                    end
                    gain_toggle_ctrl <= ~gain_toggle_ctrl;
                end
            end
        end
    end

    (* ASYNC_REG = "TRUE" *) reg [9:0] gain_meta_pclk;
    (* ASYNC_REG = "TRUE" *) reg [9:0] gain_sync_pclk;
    (* ASYNC_REG = "TRUE" *) reg [1:0] exposure_mode_meta_pclk;
    (* ASYNC_REG = "TRUE" *) reg [1:0] exposure_mode_sync_pclk;
    (* ASYNC_REG = "TRUE" *) reg       gain_toggle_meta_pclk;
    (* ASYNC_REG = "TRUE" *) reg       gain_toggle_sync_pclk;
    reg       gain_toggle_seen_pclk;
    reg [9:0] gain_active_pclk;
    reg [9:0] gain_frame_pclk;
    reg [1:0] exposure_mode_active_pclk;
    reg [1:0] exposure_mode_frame_pclk;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            gain_meta_pclk        <= 10'd256;
            gain_sync_pclk        <= 10'd256;
            exposure_mode_meta_pclk <= EXPOSURE_NORMAL;
            exposure_mode_sync_pclk <= EXPOSURE_NORMAL;
            gain_toggle_meta_pclk <= 1'b0;
            gain_toggle_sync_pclk <= 1'b0;
            gain_toggle_seen_pclk <= 1'b0;
            gain_active_pclk      <= 10'd256;
            gain_frame_pclk       <= 10'd256;
            exposure_mode_active_pclk <= EXPOSURE_NORMAL;
            exposure_mode_frame_pclk <= EXPOSURE_NORMAL;
        end else begin
            gain_meta_pclk        <= gain_ctrl;
            gain_sync_pclk        <= gain_meta_pclk;
            exposure_mode_meta_pclk <= exposure_mode_ctrl;
            exposure_mode_sync_pclk <= exposure_mode_meta_pclk;
            gain_toggle_meta_pclk <= gain_toggle_ctrl;
            gain_toggle_sync_pclk <= gain_toggle_meta_pclk;

            if (gain_toggle_sync_pclk != gain_toggle_seen_pclk) begin
                gain_toggle_seen_pclk <= gain_toggle_sync_pclk;
                gain_active_pclk      <= gain_sync_pclk;
                exposure_mode_active_pclk <= exposure_mode_sync_pclk;
            end

            // Freeze the gain for a complete frame to avoid a brightness seam.
            if (frame_start_pclk) begin
                gain_frame_pclk <= gain_active_pclk;
                exposure_mode_frame_pclk <= exposure_mode_active_pclk;
            end
        end
    end

    function [7:0] gamma_curve;
        input [7:0] y_value;
        input [9:0] gain_value;
        reg [9:0] curve_value;
        begin
            curve_value = {2'd0, y_value};
            if (gain_value >= 10'd304) begin
                // Stronger lift for a dark scene, with a monotonic curve.
                if (y_value < 8'd64)
                    curve_value = {2'd0, y_value} + ({2'd0, y_value} >> 1);
                else if (y_value < 8'd128)
                    curve_value = {2'd0, y_value} + 10'd32;
                else
                    curve_value = {2'd0, y_value} + ((10'd255 - {2'd0, y_value}) >> 2);
            end else if (gain_value >= 10'd272) begin
                // Mild lift avoids amplifying sensor noise in the shadows.
                if (y_value < 8'd64)
                    curve_value = {2'd0, y_value} + ({2'd0, y_value} >> 2);
                else if (y_value < 8'd128)
                    curve_value = {2'd0, y_value} + 10'd16;
                else
                    curve_value = {2'd0, y_value} + ((10'd255 - {2'd0, y_value}) >> 3);
            end

            if (curve_value > 10'd255)
                gamma_curve = 8'd255;
            else
                gamma_curve = curve_value[7:0];
        end
    endfunction

    // Preserve the sensor floor, then lift useful shadow detail in two short
    // segments. Spatial filtering and dark-chroma suppression remove noise;
    // crushing low luma here would erase real objects in backlit scenes.
    function [7:0] camera_shadow_curve;
        input [7:0] y_value;
        reg [9:0] y_ext;
        reg [9:0] delta;
        reg [10:0] curve_value;
        begin
            y_ext = {2'd0, y_value};
            delta = 10'd0;
            if (y_value < 8'd16) begin
                curve_value = y_ext;
            end else if (y_value < 8'd32) begin
                delta = y_ext - 10'd16;
                curve_value = 11'd16 + (delta << 1);
            end else if (y_value < 8'd64) begin
                delta = y_ext - 10'd32;
                curve_value = 11'd48 + delta + (delta >> 1);
            end else if (y_value < 8'd128) begin
                delta = y_ext - 10'd64;
                curve_value = 11'd96 + delta + (delta >> 3);
            end else if (y_value < 8'd192) begin
                delta = y_ext - 10'd128;
                curve_value = 11'd168 + delta - (delta >> 2);
            end else begin
                delta = y_ext - 10'd192;
                curve_value = 11'd216 + (delta >> 1);
            end

            if (curve_value > 11'd255)
                camera_shadow_curve = 8'd255;
            else
                camera_shadow_curve = curve_value[7:0];
        end
    endfunction

    function [7:0] camera_backlight_curve;
        input [7:0] y_value;
        reg [9:0] y_ext;
        reg [9:0] delta;
        reg [10:0] curve_value;
        begin
            y_ext = {2'd0, y_value};
            delta = 10'd0;
            if (y_value < 8'd16) begin
                curve_value = y_ext;
            end else if (y_value < 8'd32) begin
                delta = y_ext - 10'd16;
                curve_value = 11'd16 + (delta << 1);
            end else if (y_value < 8'd64) begin
                delta = y_ext - 10'd32;
                curve_value = 11'd48 + delta + (delta >> 1);
            end else if (y_value < 8'd128) begin
                delta = y_ext - 10'd64;
                curve_value = 11'd96 + delta;
            end else if (y_value < 8'd192) begin
                delta = y_ext - 10'd128;
                curve_value = 11'd160 + delta - (delta >> 2);
            end else begin
                delta = y_ext - 10'd192;
                curve_value = 11'd208 + (delta >> 2);
            end

            if (curve_value > 11'd255)
                camera_backlight_curve = 8'd255;
            else
                camera_backlight_curve = curve_value[7:0];
        end
    endfunction

    // Highlight mode keeps midtone contrast while rolling off clipped areas.
    function [7:0] camera_highlight_curve;
        input [7:0] y_value;
        reg [9:0] y_ext;
        reg [9:0] delta;
        reg [10:0] curve_value;
        begin
            y_ext = {2'd0, y_value};
            delta = 10'd0;
            if (y_value < 8'd16) begin
                curve_value = y_ext;
            end else if (y_value < 8'd32) begin
                delta = y_ext - 10'd16;
                curve_value = 11'd16 + delta + (delta >> 1);
            end else if (y_value < 8'd64) begin
                delta = y_ext - 10'd32;
                curve_value = 11'd40 + delta + (delta >> 2);
            end else if (y_value < 8'd128) begin
                delta = y_ext - 10'd64;
                curve_value = 11'd80 + delta;
            end else if (y_value < 8'd192) begin
                delta = y_ext - 10'd128;
                curve_value = 11'd144 + delta - (delta >> 2);
            end else begin
                delta = y_ext - 10'd192;
                curve_value = 11'd192 + (delta >> 1);
            end

            if (curve_value > 11'd255)
                camera_highlight_curve = 8'd255;
            else
                camera_highlight_curve = curve_value[7:0];
        end
    endfunction

    // HDMI scenes often contain black bars and bright screens at the same
    // time. These monotonic piecewise curves preserve hue by changing Y only:
    // shadows are lifted, highlights are compressed, and mixed scenes do both.
    function [7:0] exposure_curve;
        input [7:0] y_value;
        input [9:0] gain_value;
        input [1:0] exposure_mode;
        reg [9:0] y_ext;
        reg [9:0] delta;
        reg [10:0] curve_value;
        begin
            y_ext = {2'd0, y_value};
            delta = 10'd0;
            curve_value = {3'd0, y_value};

            if (EXPOSURE_AWARE == 0) begin
                curve_value = {3'd0, gamma_curve(y_value, gain_value)};
            end else begin
                case (exposure_mode)
                    EXPOSURE_SHADOW: begin
                        if (BACKLIGHT_COMPENSATION != 0)
                            curve_value = {
                                3'd0, camera_shadow_curve(y_value)
                            };
                        else
                            curve_value = {3'd0, gamma_curve(
                                y_value,
                                (gain_value >= 10'd288) ? 10'd304 : 10'd272
                            )};
                    end
                    EXPOSURE_HIGHLIGHT: begin
                        // Lift the deep shadows slightly while compressing
                        // the upper range. This keeps a backlit background
                        // visible without restoring clipped highlights.
                        if (BACKLIGHT_COMPENSATION != 0) begin
                            curve_value = {
                                3'd0, camera_highlight_curve(y_value)
                            };
                        end else if (y_value < 8'd64) begin
                            curve_value = y_ext + (y_ext >> 2);
                        end else if (y_value < 8'd128) begin
                            delta = y_ext - 10'd64;
                            curve_value = 11'd80 + delta - (delta >> 2);
                        end else if (y_value < 8'd192) begin
                            delta = y_ext - 10'd128;
                            curve_value = 11'd128 + delta - (delta >> 3);
                        end else begin
                            delta = y_ext - 10'd192;
                            curve_value = 11'd184 + (delta >> 1);
                        end
                    end
                    EXPOSURE_MIXED: begin
                        if (BACKLIGHT_COMPENSATION != 0) begin
                            curve_value = {
                                3'd0, camera_backlight_curve(y_value)
                            };
                        end else if (y_value < 8'd64) begin
                            curve_value = y_ext + (y_ext >> 2);
                        end else if (y_value < 8'd128) begin
                            curve_value = y_ext + 11'd16;
                        end else if (y_value < 8'd192) begin
                            delta = y_ext - 10'd128;
                            curve_value = 11'd144 + delta - (delta >> 2);
                        end else begin
                            delta = y_ext - 10'd192;
                            curve_value = 11'd192 + (delta >> 1);
                        end
                    end
                    default: begin
                        curve_value = {3'd0, gamma_curve(y_value, gain_value)};
                    end
                endcase
            end

            if (curve_value > 11'd255)
                exposure_curve = 8'd255;
            else
                exposure_curve = curve_value[7:0];
        end
    endfunction

    wire [9:0] gain_for_pixel = frame_start_pclk ? gain_active_pclk : gain_frame_pclk;
    wire [1:0] exposure_mode_for_pixel = frame_start_pclk ?
        exposure_mode_active_pclk : exposure_mode_frame_pclk;
    reg [7:0] luma_curve_d1;
    reg [9:0] gain_d1;
    reg [7:0] cb_d1, cr_d1;
    reg       vs_d1, de_d1;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            luma_curve_d1 <= 8'd0;
            gain_d1       <= 10'd256;
            cb_d1         <= 8'd0;
            cr_d1         <= 8'd0;
            vs_d1         <= 1'b0;
            de_d1         <= 1'b0;
        end else begin
            if (de_in) begin
                luma_curve_d1 <= exposure_curve(
                    y_in, gain_for_pixel, exposure_mode_for_pixel
                );
                cb_d1         <= cb_in;
                cr_d1         <= cr_in;
            end else begin
                luma_curve_d1 <= 8'd0;
                cb_d1         <= 8'd0;
                cr_d1         <= 8'd0;
            end
            gain_d1 <= gain_for_pixel;
            vs_d1   <= vs_in;
            de_d1   <= de_in;
        end
    end

    reg [19:0] luma_product_d2;
    reg [7:0]  cb_d2, cr_d2;
    reg        vs_d2, de_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            luma_product_d2 <= 20'd0;
            cb_d2           <= 8'd0;
            cr_d2           <= 8'd0;
            vs_d2           <= 1'b0;
            de_d2           <= 1'b0;
        end else begin
            // Explicitly widen both operands; the product needs 17 bits.
            luma_product_d2 <= {9'd0, luma_curve_d1} * {7'd0, gain_d1};
            cb_d2           <= cb_d1;
            cr_d2           <= cr_d1;
            vs_d2           <= vs_d1;
            de_d2           <= de_d1;
        end
    end

    function [7:0] clamp_luma_product;
        input [19:0] product_value;
        begin
            if (product_value > 20'd65280)
                clamp_luma_product = 8'd255;
            else
                clamp_luma_product = product_value[15:8];
        end
    endfunction

    function [7:0] camera_dark_chroma;
        input [7:0] chroma_value;
        input [7:0] luma_value;
        reg [7:0] chroma_distance;
        begin
            if (chroma_value >= 8'd128)
                chroma_distance = chroma_value - 8'd128;
            else
                chroma_distance = 8'd128 - chroma_value;

            if (luma_value < 8'd24)
                chroma_distance = chroma_distance >> 2;
            else if (luma_value < 8'd48)
                chroma_distance = chroma_distance >> 1;

            if (chroma_value >= 8'd128)
                camera_dark_chroma = 8'd128 + chroma_distance;
            else
                camera_dark_chroma = 8'd128 - chroma_distance;
        end
    endfunction

    wire [7:0] luma_clamped_d2 = clamp_luma_product(luma_product_d2);
    wire [7:0] cb_camera_d2 = camera_dark_chroma(cb_d2, luma_clamped_d2);
    wire [7:0] cr_camera_d2 = camera_dark_chroma(cr_d2, luma_clamped_d2);

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_out  <= 8'd0;
            cb_out <= 8'd0;
            cr_out <= 8'd0;
            vs_out <= 1'b0;
            de_out <= 1'b0;
        end else begin
            y_out  <= luma_clamped_d2;
            cb_out <= (BACKLIGHT_COMPENSATION != 0) ? cb_camera_d2 : cb_d2;
            cr_out <= (BACKLIGHT_COMPENSATION != 0) ? cr_camera_d2 : cr_d2;
            vs_out <= vs_d2;
            de_out <= de_d2;
        end
    end

endmodule
