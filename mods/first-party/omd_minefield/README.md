# Minefield

Opt-in in OMD+: `omd-package mod enable omd_minefield`. OMD Core can install
this package explicitly. `/minefield` opens the saved board; `/minefield new
SEED` creates a deterministic 9×9 board with 10 mines. Seeds are unsigned
32-bit integers; omitting one uses the new board's serial number. The first
opened cell and its neighbours are safe. Boards are not claimed to be guess-free.

F6 focuses the board. Arrow keys move, Enter/Space reveal, `f` places a flag,
`u` removes it, `c` chords, `p` pauses and `r` resumes. Escape closes and returns
input to the composer. Left click reveals, right click flags and middle click
chords. Flags are explicit set/remove operations, so repeating an input cannot
accidentally undo a flag. Chording requires exactly the displayed number of
adjacent flags; incorrect flags can lose the game. Reveal all 71 safe cells to win.

The board shows four rows in the interactive header, with the window following
the cursor; narrow terminals also window columns. Text and ASCII symbols give
color-independent cues: `#` covered, `F` flagged, `0` empty, `1`–`8` adjacent
mines, `*` mine and `!` incorrect flag. Brackets mark the cursor. The status names
its row, column and contents. Below 16 terminal rows or eight columns, use
`/minefield reveal ROW COL`, `flag ROW COL`, `unflag ROW COL` or `chord ROW COL`
with 1-based coordinates. `/minefield pause`, `resume` and `close` also work.
Native approvals and ordinary composer input keep their normal controls.

Boards, board identity, progress, wins and best time are one atomic CAS-protected
thread state. Concurrent stale pointer or command actions are refused; thread
forks inherit a snapshot and then save independently. Reopening, reload/resume,
losing focus, opening a native pane or closing pauses the clock. Pausing hides
the board and blocks gameplay until `r` or `/minefield resume`. Active elapsed
wall time is saved in milliseconds at each action and one-second redraw; delayed
ticks include the actual active interval. Backward clock changes cannot double
count time. Recovery starts from the last committed checkpoint and excludes the
unobserved crash/offline tail. Reload or package configuration changes pause on
the next tick without charging that interval. Wins and best time settle in the
same atomic state as the final reveal. Disabling the mod removes its timers.
No subsecond animation is promised.

Gameplay calls only event scheduling/publishing and state persistence: no model,
network, workspace writes, commands or coding activity. A closed game contributes
no view or keys and starts no timer.

Inspired by Reporails' MIT-licensed [reporails/arcade](https://github.com/reporails/arcade)
Minefield plugin, inspected 2026-10-07. This is an independent implementation;
no upstream source or assets were copied.
