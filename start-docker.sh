#!/bin/bash
set -e
set -o pipefail
shopt -s inherit_errexit

function cleanup {
  echo "Stopping..."

  set -x

  if [ "${NODEJS_PID}" != "" ]; then
    kill "${NODEJS_PID}"
    wait "${NODEJS_PID}"
  fi
}

trap cleanup SIGINT SIGTERM

cd /app

. "${NVM_DIR}/nvm.sh"
node src/main.js &
NODEJS_PID="$!"
wait "${NODEJS_PID}"


