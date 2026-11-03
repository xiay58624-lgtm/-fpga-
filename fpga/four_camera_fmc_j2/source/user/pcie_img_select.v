module pcie_img_select #(
    parameter integer TILE_WIDTH      = 1280,
    parameter integer TILE_HEIGHT     = 720,
    parameter integer PIXELS_PER_BEAT = 8
)(
    input                           clk,
    input                           rst_n,
    input                           frame_start,
    input      [3:0]                source_mask,

    output wire                     ch0_data_req,
    input      [127:0]              ch0_data,
    input                           ch0_data_valid,
    output wire                     ch1_data_req,
    input      [127:0]              ch1_data,
    input                           ch1_data_valid,
    output wire                     ch2_data_req,
    input      [127:0]              ch2_data,
    input                           ch2_data_valid,
    output wire                     ch3_data_req,
    input      [127:0]              ch3_data,
    input                           ch3_data_valid,

    input                           dma_wr_data_req,
    output reg [127:0]              dma_wr_data,
    output reg                      stream_underflow
);

localparam integer LINE_BEATS = (TILE_WIDTH * 2) / PIXELS_PER_BEAT;
localparam integer HALF_LINE_BEATS = TILE_WIDTH / PIXELS_PER_BEAT;
localparam integer FRAME_ROWS = TILE_HEIGHT * 2;

reg [11:0] col_cnt;
reg [11:0] row_cnt;
reg [1:0]  selected_channel_d;
reg        data_expected_d;
reg [3:0]  active_source_mask;

wire [1:0] selected_channel =
    (row_cnt < TILE_HEIGHT && col_cnt < HALF_LINE_BEATS) ? 2'd0 :
    (row_cnt < TILE_HEIGHT)                               ? 2'd1 :
    (col_cnt < HALF_LINE_BEATS)                           ? 2'd2 :
                                                            2'd3;

assign ch0_data_req = dma_wr_data_req && active_source_mask[0] &&
                      (selected_channel == 2'd0);
assign ch1_data_req = dma_wr_data_req && active_source_mask[1] &&
                      (selected_channel == 2'd1);
assign ch2_data_req = dma_wr_data_req && active_source_mask[2] &&
                      (selected_channel == 2'd2);
assign ch3_data_req = dma_wr_data_req && active_source_mask[3] &&
                      (selected_channel == 2'd3);

always @(*) begin
    case (selected_channel_d)
        2'd0: dma_wr_data = active_source_mask[0] ? ch0_data : 128'd0;
        2'd1: dma_wr_data = active_source_mask[1] ? ch1_data : 128'd0;
        2'd2: dma_wr_data = active_source_mask[2] ? ch2_data : 128'd0;
        2'd3: dma_wr_data = active_source_mask[3] ? ch3_data : 128'd0;
        default: dma_wr_data = 128'd0;
    endcase
end

always @(posedge clk or negedge rst_n) begin
    if (!rst_n || frame_start) begin
        col_cnt <= 12'd0;
        row_cnt <= 12'd0;
    end
    else if (dma_wr_data_req) begin
        if (col_cnt == LINE_BEATS - 1) begin
            col_cnt <= 12'd0;
            if (row_cnt == FRAME_ROWS - 1)
                row_cnt <= 12'd0;
            else
                row_cnt <= row_cnt + 12'd1;
        end
        else begin
            col_cnt <= col_cnt + 12'd1;
        end
    end
end

always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        selected_channel_d <= 2'd0;
        data_expected_d <= 1'b0;
        stream_underflow <= 1'b0;
        active_source_mask <= 4'd0;
    end
    else if (frame_start) begin
        selected_channel_d <= 2'd0;
        data_expected_d <= 1'b0;
        stream_underflow <= 1'b0;
        active_source_mask <= source_mask;
    end
    else begin
        data_expected_d <= dma_wr_data_req;
        if (dma_wr_data_req)
            selected_channel_d <= selected_channel;

        if (data_expected_d) begin
            case (selected_channel_d)
                2'd0: if (active_source_mask[0] && !ch0_data_valid)
                           stream_underflow <= 1'b1;
                2'd1: if (active_source_mask[1] && !ch1_data_valid)
                           stream_underflow <= 1'b1;
                2'd2: if (active_source_mask[2] && !ch2_data_valid)
                           stream_underflow <= 1'b1;
                2'd3: if (active_source_mask[3] && !ch3_data_valid)
                           stream_underflow <= 1'b1;
                default: stream_underflow <= 1'b1;
            endcase
        end
    end
end

endmodule
