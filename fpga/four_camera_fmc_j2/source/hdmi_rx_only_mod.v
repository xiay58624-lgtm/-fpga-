`timescale 1ns / 1ps

module hdmi_rx_only_mod #(
    parameter integer RESET_HOLD_CYCLES   = 10_000,
    parameter integer INIT_TIMEOUT_CYCLES = 5_000_000,
    parameter integer FRAME_TIMEOUT_CYCLES = 20_000_000
)(
    input  wire        cfg_clk,
    input  wire        cfg_locked,

    output wire        rstn_out,
    output wire        iic_scl,
    inout  wire        iic_sda,

    input  wire        pixclk_in,
    input  wire        vs_in,
    input  wire        hs_in,
    input  wire        de_in,
    input  wire [7:0]  r_in,
    input  wire [7:0]  g_in,
    input  wire [7:0]  b_in,

    output wire        pixclk,
    output wire        vs,
    output wire        hs,
    output wire        de,
    output wire [7:0]  r,
    output wire [7:0]  g,
    output wire [7:0]  b,
    output wire        init_over,
    output reg         video_active
);
    reg [31:0] reset_hold_cnt;
    reg [31:0] init_timeout_cnt;
    reg [31:0] frame_timeout_cnt;
    reg        reset_active;

    reg        vs_pix_d;
    reg        vs_toggle_pix;
    reg        de_pix_d;
    reg        de_toggle_pix;
    (* ASYNC_REG = "TRUE" *) reg vs_toggle_meta;
    (* ASYNC_REG = "TRUE" *) reg vs_toggle_sync;
    reg        vs_toggle_sync_d;
    (* ASYNC_REG = "TRUE" *) reg de_toggle_meta;
    (* ASYNC_REG = "TRUE" *) reg de_toggle_sync;
    reg        de_toggle_sync_d;

    wire [7:0]  device_id;
    wire        iic_trig;
    wire        w_r;
    wire [15:0] addr;
    wire [7:0]  data_in;
    wire        busy;
    wire [7:0]  data_out;
    wire        byte_over;
    wire        sda_in;
    wire        sda_out;
    wire        sda_out_en;
    wire        vs_activity;
    wire        de_activity;
    wire        video_activity;

    reg         vs_sampled;
    reg         hs_sampled;
    reg         de_sampled;
    reg  [7:0]  r_sampled;
    reg  [7:0]  g_sampled;
    reg  [7:0]  b_sampled;

    assign pixclk = pixclk_in;
    assign vs     = vs_sampled;
    assign hs     = hs_sampled;
    assign de     = de_sampled;
    assign r      = r_sampled;
    assign g      = g_sampled;
    assign b      = b_sampled;

    assign vs_activity = vs_toggle_sync ^ vs_toggle_sync_d;
    assign de_activity = de_toggle_sync ^ de_toggle_sync_d;
    assign video_activity = vs_activity | de_activity;

    // W8 reaches the global clock buffer through general routing. Capture the
    // source-synchronous bus half a cycle away from the MS7200 transition edge.
    always @(negedge pixclk_in or negedge rstn_out) begin
        if (!rstn_out) begin
            vs_sampled <= 1'b0;
            hs_sampled <= 1'b0;
            de_sampled <= 1'b0;
            r_sampled  <= 8'd0;
            g_sampled  <= 8'd0;
            b_sampled  <= 8'd0;
        end else begin
            vs_sampled <= vs_in;
            hs_sampled <= hs_in;
            de_sampled <= de_in;
            r_sampled  <= r_in;
            g_sampled  <= g_in;
            b_sampled  <= b_in;
        end
    end

    // Track both VS and DE. Some MS7200 startup phases expose stable active
    // video before the VS pin is captured reliably; treating DE transitions
    // as activity prevents the watchdog from resetting an otherwise live
    // receiver every acquisition timeout.
    always @(posedge pixclk_in or negedge rstn_out) begin
        if (!rstn_out) begin
            vs_pix_d      <= 1'b0;
            vs_toggle_pix <= 1'b0;
            de_pix_d      <= 1'b0;
            de_toggle_pix <= 1'b0;
        end else begin
            vs_pix_d <= vs_in;
            de_pix_d <= de_in;
            if (vs_in != vs_pix_d)
                vs_toggle_pix <= ~vs_toggle_pix;
            if (de_in != de_pix_d)
                de_toggle_pix <= ~de_toggle_pix;
        end
    end

    always @(posedge cfg_clk or negedge rstn_out) begin
        if (!rstn_out) begin
            vs_toggle_meta   <= 1'b0;
            vs_toggle_sync   <= 1'b0;
            vs_toggle_sync_d <= 1'b0;
            de_toggle_meta   <= 1'b0;
            de_toggle_sync   <= 1'b0;
            de_toggle_sync_d <= 1'b0;
        end else begin
            vs_toggle_meta   <= vs_toggle_pix;
            vs_toggle_sync   <= vs_toggle_meta;
            vs_toggle_sync_d <= vs_toggle_sync;
            de_toggle_meta   <= de_toggle_pix;
            de_toggle_sync   <= de_toggle_meta;
            de_toggle_sync_d <= de_toggle_sync;
        end
    end

    always @(posedge cfg_clk) begin
        if (!cfg_locked) begin
            reset_hold_cnt   <= 32'd0;
            init_timeout_cnt <= 32'd0;
            frame_timeout_cnt <= 32'd0;
            reset_active     <= 1'b1;
            video_active     <= 1'b0;
        end else if (reset_active) begin
            init_timeout_cnt  <= 32'd0;
            frame_timeout_cnt <= 32'd0;
            video_active      <= 1'b0;

            if ((RESET_HOLD_CYCLES <= 1) ||
                (reset_hold_cnt >= RESET_HOLD_CYCLES - 1)) begin
                reset_hold_cnt <= 32'd0;
                reset_active   <= 1'b0;
            end else begin
                reset_hold_cnt <= reset_hold_cnt + 1'b1;
            end
        end else if (!init_over) begin
            frame_timeout_cnt <= 32'd0;
            video_active      <= 1'b0;

            if ((INIT_TIMEOUT_CYCLES <= 1) ||
                (init_timeout_cnt >= INIT_TIMEOUT_CYCLES - 1)) begin
                reset_hold_cnt   <= 32'd0;
                init_timeout_cnt <= 32'd0;
                reset_active     <= 1'b1;
            end else begin
                init_timeout_cnt <= init_timeout_cnt + 1'b1;
            end
        end else begin
            init_timeout_cnt <= 32'd0;

            if (video_activity) begin
                frame_timeout_cnt <= 32'd0;
                video_active      <= 1'b1;
            end else if ((FRAME_TIMEOUT_CYCLES <= 1) ||
                         (frame_timeout_cnt >= FRAME_TIMEOUT_CYCLES - 1)) begin
                reset_hold_cnt    <= 32'd0;
                frame_timeout_cnt <= 32'd0;
                reset_active      <= 1'b1;
                video_active      <= 1'b0;
            end else begin
                frame_timeout_cnt <= frame_timeout_cnt + 1'b1;
            end
        end
    end

    assign rstn_out = cfg_locked & ~reset_active;

    ms7200_ctl #(
        .ALLOW_LOCKED_START(1'b1)
    ) u_ms7200_ctl(
        .clk       (cfg_clk  ),
        .rstn      (rstn_out ),
        .init_over (init_over),
        .device_id (device_id),
        .iic_trig  (iic_trig ),
        .w_r       (w_r      ),
        .addr      (addr     ),
        .data_in   (data_in  ),
        .busy      (busy     ),
        .data_out  (data_out ),
        .byte_over (byte_over)
    );

    iic_dri #(
        .CLK_FRE   (27'd10_000_000),
        .IIC_FREQ  (20'd400_000   ),
        .T_WR      (10'd1         ),
        .ADDR_BYTE (2'd2          ),
        .LEN_WIDTH (8'd3          ),
        .DATA_BYTE (2'd1          )
    ) u_iic_dri_rx (
        .clk        (cfg_clk   ),
        .rstn       (rstn_out  ),
        .device_id  (device_id ),
        .pluse      (iic_trig  ),
        .w_r        (w_r       ),
        .byte_len   (4'd1      ),
        .addr       (addr      ),
        .data_in    (data_in   ),
        .busy       (busy      ),
        .byte_over  (byte_over ),
        .data_out   (data_out  ),
        .scl        (iic_scl   ),
        .sda_in     (sda_in    ),
        .sda_out    (sda_out   ),
        .sda_out_en (sda_out_en)
    );

    assign iic_sda = sda_out_en ? sda_out : 1'bz;
    assign sda_in  = iic_sda;
endmodule
