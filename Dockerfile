FROM ubuntu:22.04 as Base

COPY .nvmrc /app/
COPY package.json /app/

ENV NVM_DIR /usr/nvm

RUN apt-get update -y \
    && apt-get upgrade -y \
    && apt-get install -y curl \
    && mkdir -p /usr/nvm \
    && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash \
    && . "${NVM_DIR}/nvm.sh" \
    && cd /app \
    && nvm install \
    && apt-get remove --autoremove -y curl

FROM Base as CompiledJavascript

COPY src /app/src
COPY tsconfig.json /app/

ENV NVM_DIR /usr/nvm

RUN cd /app \
    && . "${NVM_DIR}/nvm.sh" \
    && nvm use \
    && npm install \
    && node_modules/typescript/bin/tsc

FROM Base

COPY --from=CompiledJavascript /app/compiled-js/* /app/src/
COPY package.json /app/
COPY start-docker.sh /app/
COPY .nvmrc /app/

ENV NVM_DIR /usr/nvm

RUN cd /app \
    && cd /app \
    && . "${NVM_DIR}/nvm.sh" \
    && nvm use \
    && npm install --only=production \
    && useradd -u 3000 dockeruser

USER dockeruser

CMD [ "/app/start-docker.sh" ]
