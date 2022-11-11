/*
 * Copyright 2021-2022 Rick Kern <kernrj@gmail.com>
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import util = require('swiss-cheese');
import mqtt = require('mqtt');

const variableCodeLookup: any = Object.freeze({
                                                '00060': {
                                                  variableName: 'discharge',
                                                  displayName: 'discharge',
                                                  icon: 'mdi:waves-arrow-right',
                                                },
                                                '00065': {
                                                  variableName: 'gage_height',
                                                  displayName: 'gage height',
                                                  icon: 'mdi:waves-arrow-up',
                                                },
                                              });

function getVariableName(variableCode: string): string {
  const foundObj: any = variableCodeLookup[variableCode];

  return util.isSet(foundObj) ? foundObj.variableName : variableCode;
}

function getDisplayName(variableCode: string): string {
  const foundObj: any = variableCodeLookup[variableCode];

  return util.isSet(foundObj) ? foundObj.displayName : variableCode;
}

function getIconForVariableCode(variableCode: string): string {
  const foundObj: any = variableCodeLookup[variableCode];

  return util.isSet(foundObj) ? foundObj.icon : 'mdi:eye';
}

const log = util.getLogger('water main');
const siteIds: string = util.getStringEnvOrDie('WATER_SITES');
const waterApiEndpoint = util.getStringEnv('WATER_ENDPOINT', 'https://waterservices.usgs.gov/nwis/iv/');
const mqttEndpoint = util.getStringEnvOrDie('WATER_MQTT_ENDPOINT');
const mqttUsername = util.getStringEnvOrDie('WATER_MQTT_USERNAME');
const mqttPassword = util.getStringEnvOrDie('WATER_MQTT_PASSWORD');
const mqttTopicBase = util.getStringEnv('WATER_MQTT_TOPIC_BASE', 'homeassistant/sensor');
let exitRequested = false;

const maxBodySize = 1024 * 1024;
const updateAfterIntervalSeconds = util.getNumericEnv('WATER_UPDATE_INTERVAL', 900);
let updateTimer: util.Timer;

process.on('uncaughtException', handleUncaughtException);
process.on('SIGTERM', stopAndExit);
process.on('SIGINT', stopAndExit);

function parseIntList(commaSeparatedNumberString: string): number[] {
  util.requireNonEmptyString(commaSeparatedNumberString, 'commaSeparatedNumberString');
  const numStrings: string[] = commaSeparatedNumberString.split(',');
  const parsedIntegers: number[] = [];

  for (let i = 0; i < numStrings.length; i++) {
    parsedIntegers.push(util.parseIntOrThrow(numStrings[i].trim(), 'element of commaSeparatedNumberString'));
  }

  return parsedIntegers;
}

function stopAndExit(signal: string) {
  if (exitRequested) {
    log.i(`Got signal ${signal} after previous to stop. Stopping immediately.`);
    process.exit(0);
  }

  log.i(`Got signal ${signal}. Stopping.`);
  if (util.isSet(updateTimer)) {
    log.i('Interrupting main loop');
    updateTimer.finishEarly();
  } else {
    log.i('Not interrupting main loop - not running');
    process.exit(0);
  }

  if (util.isSet(mqttClient)) {
    log.i('Stopping MQTT client.');
    mqttClient.end();
  } else {
    log.i('MQTT client was not set. Not disconnecting.');
  }

  exitRequested = true;
}

function handleUncaughtException(e: Error): void {
  log.e(`Uncaught exception '${e.message}': ${e.stack}`);
  process.exit(1);
}

let mqttClient: mqtt.MqttClient;

async function start() {
  log.i(`Logging into MQTT server ${mqttEndpoint}`);

  await util.runWithRetry(() => {
    mqttClient = mqtt.connect(mqttEndpoint, {
      username: mqttUsername,
      password: mqttPassword,
    });

    mqttClient.on('error', (error: Error) => {
      log.e('MQTT error: ${error}');
    });

    return Promise.resolve();
  }, null, 1000);

  log.i(`Logged into MQTT server ${mqttEndpoint}`);

  while (!exitRequested) {
    updateTimer = util.createTimer(updateAfterIntervalSeconds);
    await updateStats();

    if (exitRequested) {
      log.i('Exit requested. Breaking out of main loop.');
      break;
    }

    await updateTimer.waitForTimeout();
  }

  log.i('Main loop exited.');
}

async function updateStats() {
  const parsedWaterEndpointUrl = new URL(waterApiEndpoint);

  const retryCount = 2;
  const retryIntervalInSeconds = 5;
  const response = await util.runWithRetry(async () => {
    return await util.httpMakeRequest({
                                        protocol: parsedWaterEndpointUrl.protocol,
                                        hostname: parsedWaterEndpointUrl.hostname,
                                        port: parsedWaterEndpointUrl.port,
                                        path: `${parsedWaterEndpointUrl.pathname}?format=json,1.1&site=${siteIds}`,
                                      }, '');
  }, retryCount, retryIntervalInSeconds);
  log.i(`Fetching water data`);

  const body: string = await util.readStreamAsString(response.responseBodyStream, maxBodySize);
  const json: any = JSON.parse(body);
  const timeSeries: any[] = json.value.timeSeries;
  const publishData: any = {};

  log.i(`USGS Data: ${JSON.stringify(json, null, 2)}`);
  log.i(`Publishing water data to MQTT`);

  interface PromiseInfo {
    name: String;
    promise: Promise<mqtt.Packet>;
  }

  const promises: Promise<any>[] = [];

  for (let i = 0; i < timeSeries.length; i++) {
    const entry = timeSeries[i];
    const value: number = util.parseNumberOr(entry.values[0].value[0].value, undefined);
    const timestamp: string = entry.values[0].value[0].dateTime;
    const unitOfMeasurement: string = entry.variable.unit.unitCode;
    const siteId: string = entry.sourceInfo.siteCode[0].value;

    if (util.notSet(publishData[siteId])) {
      publishData[siteId] = {};
    }

    const variableCode: string = entry.variable.variableCode[0].value;
    const variableName: string = getVariableName(variableCode);

    publishData[siteId][variableName] = {
      value,
      timestamp,
    };

    promises.push(publishHomeAssistantDiscoveryMessage(
      mqttClient,
      siteId,
      variableCode,
      entry.sourceInfo.siteName,
      unitOfMeasurement));

    const geolocation = entry.sourceInfo.geoLocation.geogLocation;
    promises.push(publishMqtt(
      mqttClient,
      getAttributesTopic(siteId),
      {
        latitude: geolocation.latitude,
        longitude: geolocation.longitude,
        datum: geolocation.srs,
      }, {
        retain: true,
      }));
  }

  util.forEachOwned(publishData, (siteId: string, publishSiteData: any) => {
    promises.push(publishMqtt(mqttClient, getStateTopic(siteId), publishSiteData, {retain: true}));
  });

  return Promise.all(promises);
}

function getConfigTopic(siteId: string, variable: string): string {
  return `${mqttTopicBase}/${siteId}/${variable}/config`;
}

function getStateTopic(siteId: string): string {
  return `${mqttTopicBase}/${siteId}/state`;
}

function getAttributesTopic(siteId: string): string {
  return `${mqttTopicBase} /${siteId}/attributes`;
}

async function publishHomeAssistantDiscoveryMessage(
  client: mqtt.MqttClient,
  siteId: string,
  variableCode: string,
  siteName: string,
  unitOfMeasurement: string): Promise<mqtt.Packet> {
  const variableName = getVariableName(variableCode);
  const displayName = getDisplayName(variableCode);
  const topic = getConfigTopic(siteId, variableName);
  const message = {
    unique_id: `${siteId}_${variableName}`,
    object_id: `${siteId}_${variableName}`,
    unit_of_measurement: unitOfMeasurement,
    state_topic: getStateTopic(siteId),
    json_attributes_topic: getAttributesTopic(siteId),
    friendlyName: `${displayName} ${siteName}`,
    name: `${displayName} ${siteName}`,
    icon: getIconForVariableCode(variableCode),
    value_template: `{{ value_json.${variableName}.value }}`,
    device: {
      identifiers: [siteId],
      name: siteName,
    },
  };

  return publishMqtt(mqttClient, topic, message, {
    retain: true,
  });
}

async function publishMqtt(
  client: mqtt.MqttClient,
  topic: string,
  message: any,
  options?: mqtt.IClientPublishOptions): Promise<mqtt.Packet> {
  log.i(`Publishing mqtt topic '${topic}': ${JSON.stringify(message, null, 2)}`);

  return new Promise<mqtt.Packet>((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify(message),
      options,
      (error?: Error, packet?: mqtt.Packet) => {
        if (util.isSet(error)) {
          reject(error);
        } else {
          resolve(packet);
        }
      });
  });
}

start()
  .catch(reason => {
    log.e(`Killing process due to error: ${reason}`);
    process.exit(1);
  })
  .then(() => {
    log.i('Water stats updater exiting.');
  });
