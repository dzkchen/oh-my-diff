#!/bin/sh
exec "${OMD_NODE:-node}" "$(dirname "$0")/server.mjs" "$@"
