`timescale 1ns / 1ps

// HDMI-specific processing for standard RGB565 video. Pixel processing and
// frame statistics stay in pclk; ctrl_clk remains only for legacy compatibility.
module hdmi_image_process_adaptive #(
    parameter integer IMG_WIDTH             = 1280,
    parameter integer VS_ACTIVE_LOW          = 1,
    parameter integer ENABLE_GAUSSIAN        = 0,
    parameter integer ENABLE_ADAPTIVE_GAMMA  = 1,
    parameter integer ENABLE_EXPOSURE_CONTROL = 1,
    parameter integer EXPOSURE_CONFIRM_FRAMES = 6,
    parameter integer HDMI_MODE               = 1,
    parameter integer ENABLE_DETAIL           = 0,
    parameter integer MIN_FRAME_PIXELS         = 800000,
    parameter integer TONE_STRENGTH_MAX_Q8     = 64
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

generate
    if ((HDMI_MODE == 0) ||
        ((ENABLE_ADAPTIVE_GAMMA == 0) && (ENABLE_DETAIL == 0))) begin : g_bypass
        assign vs_out   = vs_in;
        assign de_out   = de_in;
        assign data_out = data_in;
    end else begin : g_processing
        wire vs_active_high = (VS_ACTIVE_LOW != 0) ? ~vs_in : vs_in;

        // The shared converter used by the CMOS path expects logical R in the
        // low five bits. Swap R/B at its input; ycbcr2rgb already emits the
        // standard HDMI/DDR RGB565 order {R,G,B}.
        wire [15:0] converter_rgb565 = {
            data_in[4:0], data_in[10:5], data_in[15:11]
        };

        wire       vs_ycbcr;
        wire       de_ycbcr;
        wire [7:0] y_ycbcr;
        wire [7:0] cb_ycbcr;
        wire [7:0] cr_ycbcr;

        rgb2ycbcr u_rgb2ycbcr (
            .pclk   (pclk),
            .rst_n  (rst_n),
            .vs_in  (vs_active_high),
            .de_in  (de_in),
            .rgb_in (converter_rgb565),
            .vs_out (vs_ycbcr),
            .de_out (de_ycbcr),
            .y_out  (y_ycbcr),
            .cb_out (cb_ycbcr),
            .cr_out (cr_ycbcr)
        );

        wire       stats_valid;
        wire [7:0] stats_p05, stats_p10, stats_p50, stats_p95;
        wire [19:0] stats_total;
        wire [19:0] stats_dark, stats_shadow, stats_highlight;
        wire [19:0] stats_near_clip, stats_clip;
        wire [2:0] scene_mode;
        wire [8:0] tone_strength_q8;

        isp_luma_histogram_32 #(
            .MIN_FRAME_SAMPLES((MIN_FRAME_PIXELS < 16) ? 1 :
                               (MIN_FRAME_PIXELS / 16))
        ) u_hdmi_histogram (
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

        isp_scene_controller #(
            .MAX_STRENGTH_Q8((ENABLE_EXPOSURE_CONTROL != 0) ?
                             TONE_STRENGTH_MAX_Q8 : 0),
            .CONFIRM_FRAMES(EXPOSURE_CONFIRM_FRAMES)
        ) u_hdmi_scene_controller (
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

        wire       vs_spatial;
        wire       de_spatial;
        wire [7:0] y_spatial, cb_spatial, cr_spatial;
        wire [7:0] blur_spatial;
        wire       kernel_spatial;

        // Only ENHANCE mode allocates a spatial window. DETECT_SAFE keeps the
        // decoded HDMI pixels sharp and uses frame-level tone control alone.
        if ((HDMI_MODE == 2) && (ENABLE_DETAIL != 0)) begin : g_detail_features
            wire [7:0] feature_median;
            wire [7:0] feature_gaussian_cb, feature_gaussian_cr;
            wire [7:0] feature_min, feature_max;
            isp_3x3_features #(
                .IMG_WIDTH(IMG_WIDTH)
            ) u_hdmi_features (
                .pclk(pclk), .rst_n(rst_n),
                .vs_in(vs_ycbcr), .de_in(de_ycbcr),
                .y_in(y_ycbcr), .cb_in(cb_ycbcr), .cr_in(cr_ycbcr),
                .vs_out(vs_spatial), .de_out(de_spatial),
                .center_y(y_spatial), .center_cb(cb_spatial),
                .center_cr(cr_spatial), .median_y(feature_median),
                .gaussian_y(blur_spatial),
                .gaussian_cb(feature_gaussian_cb),
                .gaussian_cr(feature_gaussian_cr),
                .min_y(feature_min), .max_y(feature_max),
                .kernel_valid(kernel_spatial)
            );
        end else begin : g_detail_features_bypass
            assign vs_spatial = vs_ycbcr;
            assign de_spatial = de_ycbcr;
            assign y_spatial = y_ycbcr;
            assign cb_spatial = cb_ycbcr;
            assign cr_spatial = cr_ycbcr;
            assign blur_spatial = y_ycbcr;
            assign kernel_spatial = 1'b0;
        end

        wire       vs_tone;
        wire       de_tone;
        wire [7:0] y_tone, cb_tone, cr_tone;
        wire [7:0] detail_center_tone, detail_blur_tone;
        wire       detail_kernel_tone;

        isp_tone_mapper_17pt u_hdmi_tone_mapper (
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

        wire       vs_luma;
        wire       de_luma;
        wire [7:0] y_luma, cb_luma, cr_luma;

        isp_detail_enhance #(
            .ENABLE((HDMI_MODE == 2) && (ENABLE_DETAIL != 0)),
            .NOISE_GATE(6), .LIMIT_POS(4), .LIMIT_NEG(8)
        ) u_hdmi_detail_enhance (
            .pclk(pclk), .rst_n(rst_n),
            .vs_in(vs_tone), .de_in(de_tone),
            .y_in(y_tone), .cb_in(cb_tone), .cr_in(cr_tone),
            .center_y(detail_center_tone), .blur_y(detail_blur_tone),
            .kernel_valid(detail_kernel_tone),
            .vs_out(vs_luma), .de_out(de_luma),
            .y_out(y_luma), .cb_out(cb_luma), .cr_out(cr_luma)
        );

        wire        vs_rgb;
        wire        de_rgb;
        wire [15:0] rgb565_rgb;

        ycbcr2rgb u_ycbcr2rgb (
            .pclk    (pclk),
            .rst_n   (rst_n),
            .vs_in   (vs_luma),
            .de_in   (de_luma),
            .y_in    (y_luma),
            .cb_in   (cb_luma),
            .cr_in   (cr_luma),
            .vs_out  (vs_rgb),
            .de_out  (de_rgb),
            .rgb_out (rgb565_rgb)
        );

        assign vs_out   = (VS_ACTIVE_LOW != 0) ? ~vs_rgb : vs_rgb;
        assign de_out   = de_rgb;
        assign data_out = rgb565_rgb;

        // Retained for source compatibility with v8.0. The v8.1 architecture
        // intentionally never performs unconditional HDMI Gaussian filtering.
        wire unused_legacy_controls = ^{ctrl_clk, ENABLE_GAUSSIAN};
    end
endgenerate

endmodule


// Causal 3x3 Gaussian filter on luma:
//     1 2 1
//     2 4 2   / 16
//     1 2 1
// Cb/Cr are delayed by the same register pipeline but are not filtered. The
// first two rows and columns bypass the kernel so RAM contents from the prior
// frame can never leak into the next frame.
module hdmi_y_gaussian_filter #(
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
    output reg  [7:0] y_out,
    output reg  [7:0] cb_out,
    output reg  [7:0] cr_out
);

    reg [10:0] wr_ptr;
    reg [10:0] wr_ptr_d1;
    reg [10:0] active_row;
    reg        vs_d1;
    reg        de_d1;
    reg        kernel_valid_d1;
    reg [7:0]  y_row3;
    reg [7:0]  y_bypass_d1;
    reg [7:0]  cb_bypass_d1;
    reg [7:0]  cr_bypass_d1;

    wire [7:0] y_row2;
    wire [7:0] y_row1;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr          <= 11'd0;
            wr_ptr_d1       <= 11'd0;
            active_row      <= 11'd0;
            vs_d1           <= 1'b0;
            de_d1           <= 1'b0;
            kernel_valid_d1 <= 1'b0;
            y_row3          <= 8'd0;
            y_bypass_d1     <= 8'd0;
            cb_bypass_d1    <= 8'd0;
            cr_bypass_d1    <= 8'd0;
        end else begin
            vs_d1     <= vs_in;
            de_d1     <= de_in;
            wr_ptr_d1 <= wr_ptr;

            if (vs_in) begin
                wr_ptr     <= 11'd0;
                active_row <= 11'd0;
            end else if (de_in) begin
                if (wr_ptr == IMG_WIDTH - 1) begin
                    wr_ptr <= 11'd0;
                    if (active_row != 11'h7ff)
                        active_row <= active_row + 1'b1;
                end else begin
                    wr_ptr <= wr_ptr + 1'b1;
                end
            end

            kernel_valid_d1 <= de_in && !vs_in && (active_row >= 11'd2) &&
                               (wr_ptr >= 11'd2);
            if (de_in) begin
                y_row3       <= y_in;
                y_bypass_d1  <= y_in;
                cb_bypass_d1 <= cb_in;
                cr_bypass_d1 <= cr_in;
            end else begin
                y_row3       <= 8'd0;
                y_bypass_d1  <= 8'd0;
                cb_bypass_d1 <= 8'd0;
                cr_bypass_d1 <= 8'd0;
            end
        end
    end

    line_buf u_y_buf_1 (
        .wr_data (y_in),
        .wr_addr (wr_ptr),
        .wr_en   (de_in),
        .wr_clk  (pclk),
        .wr_rst  (~rst_n),
        .rd_data (y_row2),
        .rd_addr (wr_ptr),
        .rd_clk  (pclk),
        .rd_rst  (~rst_n)
    );

    line_buf u_y_buf_2 (
        .wr_data (y_row2),
        .wr_addr (wr_ptr_d1),
        .wr_en   (de_d1),
        .wr_clk  (pclk),
        .wr_rst  (~rst_n),
        .rd_data (y_row1),
        .rd_addr (wr_ptr),
        .rd_clk  (pclk),
        .rd_rst  (~rst_n)
    );

    reg [7:0] y_p11, y_p12, y_p13;
    reg [7:0] y_p21, y_p22, y_p23;
    reg [7:0] y_p31, y_p32, y_p33;
    reg       vs_d2, de_d2, kernel_valid_d2;
    reg [7:0] y_bypass_d2, cb_bypass_d2, cr_bypass_d2;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            {y_p11, y_p12, y_p13} <= 24'd0;
            {y_p21, y_p22, y_p23} <= 24'd0;
            {y_p31, y_p32, y_p33} <= 24'd0;
            vs_d2                  <= 1'b0;
            de_d2                  <= 1'b0;
            kernel_valid_d2        <= 1'b0;
            y_bypass_d2            <= 8'd0;
            cb_bypass_d2           <= 8'd0;
            cr_bypass_d2           <= 8'd0;
        end else begin
            vs_d2           <= vs_d1;
            de_d2           <= de_d1;
            kernel_valid_d2 <= kernel_valid_d1;
            y_bypass_d2     <= y_bypass_d1;
            cb_bypass_d2    <= cb_bypass_d1;
            cr_bypass_d2    <= cr_bypass_d1;
            if (de_d1) begin
                y_p13 <= y_p12;
                y_p12 <= y_p11;
                y_p11 <= y_row1;
                y_p23 <= y_p22;
                y_p22 <= y_p21;
                y_p21 <= y_row2;
                y_p33 <= y_p32;
                y_p32 <= y_p31;
                y_p31 <= y_row3;
            end
        end
    end

    reg [9:0]  y_sum1, y_sum3;
    reg [10:0] y_sum2;
    reg        vs_d3, de_d3, kernel_valid_d3;
    reg [7:0]  y_bypass_d3, cb_bypass_d3, cr_bypass_d3;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_sum1           <= 10'd0;
            y_sum2           <= 11'd0;
            y_sum3           <= 10'd0;
            vs_d3            <= 1'b0;
            de_d3            <= 1'b0;
            kernel_valid_d3  <= 1'b0;
            y_bypass_d3      <= 8'd0;
            cb_bypass_d3     <= 8'd0;
            cr_bypass_d3     <= 8'd0;
        end else begin
            y_sum1 <= {2'b0, y_p11} + ({2'b0, y_p12} << 1) +
                      {2'b0, y_p13};
            y_sum2 <= ({3'b0, y_p21} << 1) + ({3'b0, y_p22} << 2) +
                      ({3'b0, y_p23} << 1);
            y_sum3 <= {2'b0, y_p31} + ({2'b0, y_p32} << 1) +
                      {2'b0, y_p33};
            vs_d3           <= vs_d2;
            de_d3           <= de_d2;
            kernel_valid_d3 <= kernel_valid_d2;
            y_bypass_d3     <= y_bypass_d2;
            cb_bypass_d3    <= cb_bypass_d2;
            cr_bypass_d3    <= cr_bypass_d2;
        end
    end

    reg [11:0] y_total;
    reg        vs_d4, de_d4, kernel_valid_d4;
    reg [7:0]  y_bypass_d4, cb_bypass_d4, cr_bypass_d4;

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            y_total          <= 12'd0;
            vs_d4            <= 1'b0;
            de_d4            <= 1'b0;
            kernel_valid_d4  <= 1'b0;
            y_bypass_d4      <= 8'd0;
            cb_bypass_d4     <= 8'd0;
            cr_bypass_d4     <= 8'd0;
        end else begin
            y_total         <= y_sum1 + y_sum2 + y_sum3;
            vs_d4           <= vs_d3;
            de_d4           <= de_d3;
            kernel_valid_d4 <= kernel_valid_d3;
            y_bypass_d4     <= y_bypass_d3;
            cb_bypass_d4    <= cb_bypass_d3;
            cr_bypass_d4    <= cr_bypass_d3;
        end
    end

    always @(posedge pclk or negedge rst_n) begin
        if (!rst_n) begin
            vs_out <= 1'b0;
            de_out <= 1'b0;
            y_out  <= 8'd0;
            cb_out <= 8'd0;
            cr_out <= 8'd0;
        end else begin
            vs_out <= vs_d4;
            de_out <= de_d4;
            if (de_d4) begin
                y_out  <= kernel_valid_d4 ? y_total[11:4] : y_bypass_d4;
                cb_out <= cb_bypass_d4;
                cr_out <= cr_bypass_d4;
            end else begin
                y_out  <= 8'd0;
                cb_out <= 8'd0;
                cr_out <= 8'd0;
            end
        end
    end

endmodule
