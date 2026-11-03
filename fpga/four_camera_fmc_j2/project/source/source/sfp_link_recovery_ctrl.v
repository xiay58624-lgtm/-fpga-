`timescale 1ns / 1ps

// Re-arms the complete SFP receive session after a PHY loss or protocol
// silence. Resets assert asynchronously and release synchronously in each
// destination domain. The parser is allowed to run while waiting for the
// first packet; pixel processing remains reset until real traffic is present.
module sfp_link_recovery_ctrl #(
    parameter integer LINK_STABLE_CYCLES = 4096,
    parameter integer RX_ACTIVITY_TIMEOUT_CYCLES = 1000000,
    parameter integer RX_RESET_HOLD_CYCLES = 8
)(
    input  wire rx_clk,
    input  wire pixclk,
    input  wire base_rst,
    input  wire rx_valid,
    input  wire rx_activity,
    output wire phy_path_rst,
    output wire rx_path_rst,
    output wire pix_path_rst,
    output reg  link_ready
);

    function integer clog2;
        input integer value;
        integer i;
        begin
            value = value - 1;
            for (i = 0; value > 0; i = i + 1)
                value = value >> 1;
            clog2 = (i == 0) ? 1 : i;
        end
    endfunction

    localparam integer STABLE_COUNT_WIDTH = clog2(LINK_STABLE_CYCLES + 1);
    localparam integer IDLE_COUNT_WIDTH =
        clog2(RX_ACTIVITY_TIMEOUT_CYCLES + 1);
    localparam integer HOLD_COUNT_WIDTH = clog2(RX_RESET_HOLD_CYCLES + 1);

    wire phy_reset_async = base_rst | ~rx_valid;

    (* ASYNC_REG = "TRUE" *) reg [2:0] rx_rst_sync;
    always @(posedge rx_clk or posedge phy_reset_async) begin
        if (phy_reset_async)
            rx_rst_sync <= 3'b111;
        else
            rx_rst_sync <= {rx_rst_sync[1:0], 1'b0};
    end

    assign phy_path_rst = rx_rst_sync[2];

    reg [IDLE_COUNT_WIDTH-1:0] rx_idle_count;
    reg [HOLD_COUNT_WIDTH-1:0] rx_reset_hold;
    reg                        protocol_seen;

    wire watchdog_reset = (rx_reset_hold != {HOLD_COUNT_WIDTH{1'b0}});
    assign rx_path_rst = phy_path_rst | watchdog_reset;

    always @(posedge rx_clk or posedge phy_reset_async) begin
        if (phy_reset_async) begin
            rx_idle_count <= {IDLE_COUNT_WIDTH{1'b0}};
            rx_reset_hold <= {HOLD_COUNT_WIDTH{1'b0}};
            protocol_seen <= 1'b0;
        end else if (rx_rst_sync[2]) begin
            rx_idle_count <= {IDLE_COUNT_WIDTH{1'b0}};
            rx_reset_hold <= {HOLD_COUNT_WIDTH{1'b0}};
            protocol_seen <= 1'b0;
        end else if (watchdog_reset) begin
            rx_idle_count <= {IDLE_COUNT_WIDTH{1'b0}};
            rx_reset_hold <= rx_reset_hold - 1'b1;
            protocol_seen <= 1'b0;
        end else if (rx_activity) begin
            rx_idle_count <= {IDLE_COUNT_WIDTH{1'b0}};
            protocol_seen <= 1'b1;
        end else if (protocol_seen) begin
            if ((RX_ACTIVITY_TIMEOUT_CYCLES <= 1) ||
                (rx_idle_count == RX_ACTIVITY_TIMEOUT_CYCLES - 1)) begin
                rx_idle_count <= {IDLE_COUNT_WIDTH{1'b0}};
                rx_reset_hold <= RX_RESET_HOLD_CYCLES;
                protocol_seen <= 1'b0;
            end else begin
                rx_idle_count <= rx_idle_count + 1'b1;
            end
        end
    end

    // protocol_seen is asserted in rx_clk and is used only as an asynchronous
    // reset request here. The three-stage chain guarantees synchronous release
    // in pixclk after both PHY lock and real packet traffic have returned.
    wire pix_reset_async = base_rst | rx_path_rst | ~protocol_seen;
    (* ASYNC_REG = "TRUE" *) reg [2:0] pix_rst_sync;
    always @(posedge pixclk or posedge pix_reset_async) begin
        if (pix_reset_async)
            pix_rst_sync <= 3'b111;
        else
            pix_rst_sync <= {pix_rst_sync[1:0], 1'b0};
    end

    reg [STABLE_COUNT_WIDTH-1:0] stable_count;
    always @(posedge pixclk or posedge pix_rst_sync[2]) begin
        if (pix_rst_sync[2]) begin
            stable_count <= {STABLE_COUNT_WIDTH{1'b0}};
            link_ready   <= 1'b0;
        end else if (!link_ready) begin
            if ((LINK_STABLE_CYCLES <= 1) ||
                (stable_count == LINK_STABLE_CYCLES - 1)) begin
                stable_count <= stable_count;
                link_ready   <= 1'b1;
            end else begin
                stable_count <= stable_count + 1'b1;
            end
        end
    end

    assign pix_path_rst = pix_rst_sync[2] | ~link_ready;

endmodule
