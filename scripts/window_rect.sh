#!/usr/bin/env bash
# Print "X Y W H" of the Booster Studio window on X11, clamped to the screen.
# Used by the window recorder to crop an x11grab capture to that area.
# Requires: wmctrl, xdpyinfo (x11-utils).
set -u

LINE=$(wmctrl -G -l 2>/dev/null | grep "Booster Studio" | head -1)
[ -z "$LINE" ] && { echo ""; exit 1; }
# wmctrl -G -l columns: window-id desktop x y w h host title...
set -- $LINE
GX=$3; GY=$4; GW=$5; GH=$6

DIM=$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}')
[ -z "$DIM" ] && { echo ""; exit 1; }
SW=${DIM%x*}; SH=${DIM#*x}

clamp() {
    local v=$1 lo=$2 hi=$3
    [ "$v" -lt "$lo" ] && v=$lo
    [ "$v" -gt "$hi" ] && v=$hi
    echo "$v"
}
X=$(clamp "$GX" 0 "$((SW-1))")
Y=$(clamp "$GY" 0 "$((SH-1))")
X2=$(clamp "$((GX+GW))" 0 "$SW")
Y2=$(clamp "$((GY+GH))" 0 "$SH")
W=$(( (X2-X)/2*2 ))
H=$(( (Y2-Y)/2*2 ))
[ "$W" -le 0 ] && { echo ""; exit 1; }
echo "$X $Y $W $H"
