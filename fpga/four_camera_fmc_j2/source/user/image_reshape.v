module image_reshape #(
    // 1: legacy 2x2 point sampling; 0: preserve every active pixel.
    parameter HALF_SAMPLE_ENABLE = 1'b1
)(
    input                           clk                     ,
    input                           rst_n                   ,

    input                           img_vs               ,
    input                           img_data_valid       ,
    input       [15:0]              img_data             ,

    input       [3:0]               channel_select          , //bit3:ch3, bit2:ch2, bit1:ch1, bit0:ch0

    output reg                      img_data_valid_out   ,
    output reg  [15:0]              img_data_out
);


localparam  [11:0]  COL_NUM = 12'd1280;        
localparam  [11:0]  HALF_COL_NUM = 12'd640;   
localparam  [11:0]  ROW_NUM = 12'd720;        
localparam  [11:0]  HALF_ROW_NUM = 12'd360;

reg                 img_vs_dly1        ;
reg                 img_vs_dly2        ;
reg                 img_vs_pos         ;

reg [11:0]          col_cnt               ;
reg [11:0]          row_cnt               ;


always @(posedge clk) begin
    if(!rst_n) begin
        img_vs_dly1 <= 1'b0;
        img_vs_dly2 <= 1'b0;
        img_vs_pos  <= 1'b0;
    end
    else begin
        img_vs_dly1 <= img_vs;
        img_vs_dly2 <= img_vs_dly1;
        img_vs_pos  <= img_vs_dly1 & (~img_vs_dly2);
    end
end

always @(posedge clk)begin
    if (!rst_n)begin
        col_cnt <= 12'd1;
    end
    else if (img_data_valid == 1'b1 && col_cnt == COL_NUM)begin
        col_cnt <= 12'd1;
    end
    else if (img_vs_pos == 1'b1)begin
        col_cnt <= 12'd1;
    end
    else if (img_data_valid == 1'b1)begin
        col_cnt <= col_cnt + 12'd1;
    end
    else begin
        col_cnt <= col_cnt;
    end
end

always @(posedge clk)begin
    if (!rst_n)begin
        row_cnt <= 12'd1;
    end
    else if (img_data_valid == 1'b1 && col_cnt == COL_NUM && row_cnt == ROW_NUM)begin
        row_cnt <= 12'd1;
    end
    else if (img_vs_pos == 1'b1)begin
        row_cnt <= 12'd1;
    end
    else if (img_data_valid == 1'b1 && col_cnt == COL_NUM)begin
        row_cnt <= row_cnt + 12'd1;
    end
    else begin
        row_cnt <= row_cnt;
    end
end

always @(posedge clk)begin
    if (!rst_n)begin
        img_data_valid_out <= 1'b0;
        img_data_out <= 16'd0;
    end
    else if (img_data_valid == 1'b1 &&
             (!HALF_SAMPLE_ENABLE || (col_cnt[0] == 1'b1 && row_cnt[0] == 1'b1)))begin
        img_data_valid_out <= img_data_valid;
        img_data_out <= img_data;
    end
    else begin
        img_data_valid_out <= 1'b0;
        img_data_out <= img_data_out;
    end
end

endmodule
