

`timescale 1ns/1ps

`include "lcd_para.v"

module lcd_driver #(
	//	Setting up default timing
	parameter 	H_FRONT	= `H_FRONT,
			H_SYNC 	= `H_SYNC,
			H_BACK 	= `H_BACK,
			H_DISP	= `H_DISP,
			H_TOTAL	= `H_TOTAL,
						
			V_FRONT	= `V_FRONT,
			V_SYNC 	= `V_SYNC,
			V_BACK 	= `V_BACK,
			V_DISP 	= `V_DISP,
			V_TOTAL	= `V_TOTAL,

			V_SYNC_BACK = V_SYNC + V_BACK,

			H_SYNC_BACK = H_SYNC + H_BACK,
			
			DATA_WIDTH 	= 16
)(  	
	//global clock
	input					clk,			//system clock
	input					rst_n,     		//sync reset
	
	//lcd interface
	output				lcd_dclk,   	//lcd pixel clock
	output				lcd_blank,		//lcd blank
	output				lcd_sync,		//lcd sync
	output reg			lcd_hs,	    	//lcd horizontal sync
	output reg			lcd_vs,	    	//lcd vertical sync
	output reg			lcd_en,			//lcd display enable
	output	[DATA_WIDTH-1:0]	lcd_rgb,		//lcd display data

	//user interface
	output reg			lcd_request,	//lcd data request
	output reg	[11:0]	lcd_xpos,		//lcd horizontal coordinate
	output reg	[11:0]	lcd_ypos,		//lcd vertical coordinate

	output reg          lcd_req,        //在vsync下降沿置1
	input               lcd_req_ack,        //lcd_req被ack后清0
	input 	[DATA_WIDTH-1:0]	lcd_data		//lcd data
);	 


//================================================================
// lcd_req
//================================================================
reg lcd_vs_dly;

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_vs_dly <= 1'b0;
	end
	else begin
		lcd_vs_dly <= lcd_vs;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_req <= 1'b0;
	end
	else if (lcd_vs_dly == 1'b1 && lcd_vs == 1'b0)begin
		lcd_req <= 1'b1;
	end
	else if (lcd_req_ack == 1'b1)begin
		lcd_req <= 1'b0;
	end
	else begin
		lcd_req <= lcd_req;
	end
end

/*******************************************
		SYNC--BACK--DISP--FRONT
*******************************************/
//------------------------------------------
//h_sync counter & generator
reg [13:0] hcnt; 
always @ (posedge clk or negedge rst_n)
begin
	if (!rst_n)
		hcnt <= 12'd0;
	else
		begin
        if(hcnt < H_TOTAL - 1'b1)		//line over			
            hcnt <= hcnt + 1'b1;
        else
            hcnt <= 12'd0;
        
        lcd_hs <= (hcnt <= H_SYNC - 1'b1) ? 1'b0 : 1'b1;
		end
end 


//------------------------------------------
//v_sync counter & generator
reg [11:0] vcnt;
always@(posedge clk or negedge rst_n)
begin
	if (!rst_n)
		vcnt <= 12'b0;
	else if(hcnt == H_TOTAL - 1'b1)		//line over
		begin
		if(vcnt < V_TOTAL - 1'b1)		//frame over
			vcnt <= vcnt + 1'b1;
		else
			vcnt <= 12'd0;
            
        lcd_vs <= (vcnt <= V_SYNC - 1'b1) ? 1'b0 : 1'b1;
		end
end


//------------------------------------------
//LCELL	LCELL(.in(clk),.out(lcd_dclk));
assign	lcd_dclk = ~clk;
assign	lcd_blank = lcd_hs & lcd_vs;		
assign	lcd_sync = 1'b0;


//-----------------------------------------
reg     [DATA_WIDTH-1:0]  r_lcd_rgb = 0; 

reg        lcd_en_hcnt_flag;
reg        lcd_en_vcnt_flag;

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_en_hcnt_flag <= 1'b0;
	end
	else if (hcnt >= H_SYNC_BACK - 1'b1 && hcnt < H_SYNC_BACK + H_DISP - 1'b1)begin
		lcd_en_hcnt_flag <= 1'b1;
	end
	else begin
		lcd_en_hcnt_flag <= 1'b0;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_en_vcnt_flag <= 1'b0;
	end
	else if (vcnt >= V_SYNC_BACK  && vcnt < V_SYNC_BACK + V_DISP)begin
		lcd_en_vcnt_flag <= 1'b1;
	end
	else begin
		lcd_en_vcnt_flag <= 1'b0;
	end
end

always@(posedge clk or negedge rst_n) begin
	if (!rst_n)begin
		lcd_en <= 1'b0;
	end
	else if (lcd_en_hcnt_flag==1'b1 && lcd_en_vcnt_flag==1'b1)begin
		lcd_en <= 1'b1;
	end
	else begin
		lcd_en <= 1'b0;
	end
end

always @(posedge clk or negedge rst_n) begin
	if (!rst_n)begin
		r_lcd_rgb <= 0;
	end
	else begin
		r_lcd_rgb <= lcd_data;
	end
end

assign lcd_rgb = lcd_en ? r_lcd_rgb : 0; 

//------------------------------------------
//ahead x clock
localparam	H_AHEAD = 	12'd2;


//	Standard FIFO Request Port
reg        lcd_request_hcnt_flag;
reg        lcd_request_vcnt_flag;

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_request_hcnt_flag <= 1'b0;
	end
	else if (hcnt >= H_SYNC_BACK - H_AHEAD- 1'b1 && hcnt < H_SYNC_BACK + H_DISP - H_AHEAD - 1'b1)begin
		lcd_request_hcnt_flag <= 1'b1;
	end
	else begin
		lcd_request_hcnt_flag <= 1'b0;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_request_vcnt_flag <= 1'b0;
	end
	else if (vcnt >= V_SYNC_BACK && vcnt < V_SYNC_BACK + V_DISP)begin
		lcd_request_vcnt_flag <= 1'b1;
	end
	else begin
		lcd_request_vcnt_flag <= 1'b0;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_request <= 1'b0;
	end
	// else if ((hcnt >= H_SYNC + H_BACK - H_AHEAD && hcnt < H_SYNC + H_BACK + H_DISP - H_AHEAD) &&
	// 					 (vcnt >= V_SYNC + V_BACK && vcnt < V_SYNC + V_BACK + V_DISP)) begin
	// 	lcd_request <= 1'b1;
	// end
	else if (lcd_request_hcnt_flag==1'b1 && lcd_request_vcnt_flag==1'b1)begin
		lcd_request <= 1'b1;
	end
	else begin
		lcd_request <= 1'b0;
	end
end


reg        pos_hcnt_flag;
reg        pos_vcnt_flag;
reg        pos_en;

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		pos_hcnt_flag <= 1'b0;
	end
	else if (hcnt >= H_SYNC_BACK - H_AHEAD- 2'd2 && hcnt < H_SYNC_BACK + H_DISP - H_AHEAD - 2'd2)begin
		pos_hcnt_flag <= 1'b1;
	end
	else begin
		pos_hcnt_flag <= 1'b0;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		pos_vcnt_flag <= 1'b0;
	end
	else if (vcnt >= V_SYNC_BACK && vcnt < V_SYNC_BACK + V_DISP)begin
		pos_vcnt_flag <= 1'b1;
	end
	else begin
		pos_vcnt_flag <= 1'b0;
	end
end



always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		pos_en <= 1'b0;
	end
	// else if ((hcnt >= H_SYNC + H_BACK - H_AHEAD && hcnt < H_SYNC + H_BACK + H_DISP - H_AHEAD) &&
	// 					 (vcnt >= V_SYNC + V_BACK && vcnt < V_SYNC + V_BACK + V_DISP)) begin
	// 	lcd_request <= 1'b1;
	// end
	else if (pos_hcnt_flag==1'b1 && pos_vcnt_flag==1'b1)begin
		pos_en <= 1'b1;
	end
	else begin
		pos_en <= 1'b0;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_xpos <= 12'd0;
		// lcd_ypos <= 12'd0;
	end
	else if (pos_en)begin
		lcd_xpos <= (hcnt + H_AHEAD)- H_SYNC_BACK + 12'd1 ;//hcnt - (H_SYNC + H_BACK - H_AHEAD);
		// lcd_ypos <= vcnt - V_SYNC_BACK;
	end
	else begin
		lcd_xpos <= 12'd0;
		// lcd_ypos <= 12'd0;
	end
end

always @(posedge clk or negedge rst_n)begin
	if (!rst_n)begin
		lcd_ypos <= 12'd0;
	end
	else if (pos_en)begin
		lcd_ypos <= vcnt - V_SYNC_BACK + 12'd1;
	end
	else begin
		lcd_ypos <= 12'd0;
	end
end
//	Standard FIFO Request Port
//  always@(posedge clk) begin
// 	lcd_request	<=	(hcnt >= H_SYNC + H_BACK - H_AHEAD && hcnt < H_SYNC + H_BACK + H_DISP - H_AHEAD) &&
// 						 (vcnt >= V_SYNC + V_BACK && vcnt < V_SYNC + V_BACK + V_DISP) 
// 						 ? 1'b1 : 1'b0;

                         
// // lcd xpos & ypos
// 	lcd_xpos	<= 	lcd_request ? (hcnt - (H_SYNC + H_BACK - H_AHEAD)) : 11'd0;
// 	lcd_ypos	<= 	lcd_request ? (vcnt - (V_SYNC + V_BACK)) : 12'd0;
// end


endmodule
