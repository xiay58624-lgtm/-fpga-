# FPGA 源码范围与硬件核验边界

主工程来自本地 `_incoming_four_camera_fmc_j2_gray_20261026/four_camera_fmc_j2`，目标 PG2L100H-6-FBG484；包含 RTL、PDS、FDC 及 IP 文件。
两路 F_GPIO 和两路 FMC J2 分别进入四个独立 PCIe 画面。
本地最新源码使用 KEY1/M16 选择九种逐像素处理模式；KEY0/M15 保持复位用途。

这份源码有后续修改，原目录的历史 `.sbit` 不对应最新源码，未收入可烧录交付。
本次没有连接 FPGA 下载器、读回烧录版本或重新运行 Pango 综合布局布线，因此不能认定这份源码就是芯片当前烧录内容。
工程 README 保留了原有历史说明。重建前应核对该板 FBG484 的 FMC 管脚和约束，尤其历史资料中 CMOS4 D7/SDA 的冲突记录；本次归档不擅自修改引脚。
在 Pango Design Suite 打开 `four_camera_fmc_j2/project/project.pds`。PDS 引用的实现结果目录不会随包带入，请重新构建，勿使用旧日志代表构建通过。
