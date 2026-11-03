`timescale 1ns / 1ps
//////////////////////////////////////////////////////////////////////////////////
// Company:Meyesemi 
// Engineer: Will
// 
// Create Date: 2023-03-17  
// Design Name:  
// Module Name: 
// Project Name: 
// Target Devices: Pango
// Tool Versions: 
// Description: 
//      
// Dependencies: 
// 
// Revision:
// Revision 1.0 - File Created
// Additional Comments:
// 
//////////////////////////////////////////////////////////////////////////////////
//������8bit����ƴ��һ��16bit RGB565���ݣ�
`timescale 1ns/1ns

module cmos_8_16bit_fmc(
	input 				   pclk 		,   
	input 				   rst_n		,
	input				   de_i	        ,
	input	[7:0]	       pdata_i	    ,
    input                  vs_i         ,

    output                 pixel_clk    ,
 	output	reg			   de_o         ,
	output  reg [15:0]	   pdata_o
); 
reg			de_out1          ;
reg [15:0]	pdata_out1       ;
reg			de_out2          ;
reg [15:0]	pdata_out2       ;    
reg [1:0]   cnt             ;
wire        pclk_IOCLKBUF   ;
reg         vs_i_reg        ;
reg         enble           ;
reg [7:0] pdata_i_reg;
reg de_i_r,de_i_r1;
reg			de_out3          ;
reg [15:0]	pdata_out3       ;  
wire        pclk_div         ;

always @(posedge pclk)begin
       vs_i_reg <= vs_i ;
end
    always@(posedge pclk)
        begin
            if(!rst_n)
                enble <= 1'b0;
            else if(!vs_i_reg&&vs_i)
                enble <= 1'b1;
            else
                enble <= enble;
        end

// GTP_IOCLKBUF #(
//     .GATE_EN("FALSE")//
// ) u_GTP_IOCLKBUF (
//     .CLKOUT(pclk_IOCLKBUF),// OUTPUT  
//     .CLKIN(pclk), // INPUT  
//     .DI(enble)     // INPUT  
// );



GTP_IOCLKDIV_E2 #(
    .DIV_FACTOR("2")
) u_GTP_IOCLKDIV (
    .CLKDIVOUT(pclk_div),// OUTPUT  
    .CE(1'b1),       // INPUT  
    .CLKIN(pclk),    // INPUT  
    .RST_N(enble)     // INPUT  
);

GTP_CLKBUFG U_CLKBUFG ( 
.CLKOUT     (pixel_clk), 
.CLKIN      (pclk_div)
); 

    always@(posedge pclk)
        begin
            if(!rst_n)
                cnt <= 2'b0;
            else if(de_i == 1'b1 && cnt == 2'd1)
                cnt <= 2'b0;
            else if(de_i == 1'b1)
                cnt <= cnt + 1'b1;
        end
    

    always@(posedge pclk)
        begin
            if(!rst_n)
                pdata_i_reg <= 8'b0;
            else if(de_i == 1'b1)
                pdata_i_reg <= pdata_i;
        end
    
    always@(posedge pclk)
        begin
            if(!rst_n)
                pdata_out1 <= 16'b0;
            else if(de_i == 1'b1 && cnt == 2'd1)
                pdata_out1 <= {pdata_i_reg,pdata_i};
        end
  

   always@(posedge pclk)begin
        de_i_r <= de_i;
        de_i_r1 <= de_i_r;
   end
    always@(posedge pclk)
        begin
            if(!rst_n)
                de_out1 <= 1'b0;
            else if(!de_i_r1 && de_i_r )//������
                de_out1 <= 1'b1;
            else if(de_i_r1 && !de_i_r )//�½���
                de_out1 <= 1'b0;
            else
                de_out1 <= de_out1;
        end


 
    always@(posedge pixel_clk)begin
        de_out2<=de_out1;
        de_out3<=de_out2;
        de_o   <=de_out3;
    end
    always@(posedge pixel_clk)begin
        pdata_out2<=pdata_out1;
        pdata_out3<=pdata_out2;
        pdata_o   <=pdata_out3;
    end
endmodule