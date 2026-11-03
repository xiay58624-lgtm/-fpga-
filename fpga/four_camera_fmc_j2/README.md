# PG2L100H four-camera FMC J2 variant

This is a separate build variant. The original `scheme2_dual_ov5640_dup`
project remains unchanged.

## Source mapping

| PCIe tile/source | Camera location | Top-level signal |
|---|---|---|
| 0 | F_GPIO camera 1 | CMOS1 |
| 1 | F_GPIO camera 2 | CMOS2 |
| 2 | FMC J2 camera 1 | CMOS3 |
| 3 | FMC J2 camera 2 | CMOS4 |

The four inputs are independent. Tiles 0, 1, 2 and 3 are not copies of one
another. The top level converts each DVP stream from 8-bit to RGB565, writes
four independent DDR3 frame channels, and `pcie_img_select` emits a 2x2
1280x720 RGB565 frame to PCIe.

## Project files

- `project/project.pds`: PG2L100H-6-FBG484 Pango project
- `project/project.fdc`: F_GPIO plus FMC CMOS3/CMOS4 pin and clock constraints
- `source/image_pcie_capture.v`: four independent camera paths
- `source/cmos_j2/`: known-working J2 reset, SCCB and 8-to-16-bit capture modules

## Important status

## 2026-10-26 multi-mode processing update

The former KEY1 gray toggle in `source/image_pcie_capture.v` is now a
debounced cyclic selector with these nine modes:

`0` original, `1` grayscale, `2` negative, `3` global binary, `4` red
channel, `5` green channel, `6` blue channel, `7` dark-region suppression,
and `8` warm/sepia enhancement. The next KEY1 press after mode 8 returns to
original mode 0.

KEY1 remains the active-low M16 button. KEY0/M15 remains the board reset and
does not select image processing. Each camera synchronizes the selected mode
and commits it on its own VSYNC rising edge, preventing a single frame from
containing two processing modes. The implementation is pixel-local RGB565
processing; neighborhood filters such as Gaussian, median, morphology and
Sobel were not added to this timing-sensitive capture path.

This source change has been statically checked for the mode wiring and source
mapping. Pango synthesis/P&R has not been rerun for this update, and the
existing `.sbit` in `project/generate_bitstream/` is historical output and
must not be treated as containing these new modes.

This workspace change establishes the source and constraint structure. It has
not yet been compiled into a new `.sbit`, flashed to an FPGA, checked for PCIe
enumeration, or observed as four live images. Those are separate verification
steps. The FMC J2 physical wiring and 3.3 V/GND/pin-1 orientation must match
the board documentation before power-up.

The FMC J2 cameras use the known-working `power_on_delay`, `reg_config`, and
`cmos_8_16bit` path from `fpga_1011_xy`, mapped onto CMOS3/4. These modules
are isolated under `source/cmos_j2/`; their module names are suffixed `_j2` so
they do not replace the FGPIO modules. Only module declarations were renamed;
the register tables and capture logic are unchanged. The old experimental
`source/cmos_fmc/` files are not part of the PDS source list. The J2 data and
sync inputs use the same input-register attributes as the working project.

## 2026-10-18 J2 wiring correction

Both FMC cameras are on J2. Per the OV5640 module pinout and the user's wiring,
camera-module pin 3 (D7) is wired to FMC J2 pin 15 and pin 4 (SDA) to FMC J2
pin 16; module pins 15 and 16 are unused. The FMC manual maps J2 pins 15/16 to
FPGA balls AC24/AB24, so CMOS4 D7 and SDA use those LOCs. Other CMOS4 pins keep
the existing mapping. This changes only these two LOC entries in
`project/project.fdc`; the DDR, PCIe, source mapping and status logic are
unchanged.

Any generated files under `project/compile`, `project/place_route` or
`project/generate_bitstream` are historical reference outputs copied with the
base project; they do not correspond to the final J2 pinout in this variant and
must not be flashed. Run a fresh Pango build before using a bitstream.

