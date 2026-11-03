`timescale 1ns / 1ps
module sort_unit(
    input  wire        clk,
    input  wire        rst_n,
    input  wire [7:0]  a, b, c,
    output reg  [7:0]  max, mid, min
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            max <= 8'd0; mid <= 8'd0; min <= 8'd0;
        end else begin
            if (a >= b && a >= c) begin
                max <= a;
                if (b >= c) begin mid <= b; min <= c; end
                else        begin mid <= c; min <= b; end
            end else if (b >= a && b >= c) begin
                max <= b;
                if (a >= c) begin mid <= a; min <= c; end
                else        begin mid <= c; min <= a; end
            end else begin
                max <= c;
                if (a >= b) begin mid <= a; min <= b; end
                else        begin mid <= b; min <= a; end
            end
        end
    end
endmodule