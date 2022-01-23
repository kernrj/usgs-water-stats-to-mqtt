/*
 * Copyright 2021 Rick Kern <kernrj@gmail.com>
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
import {IClientPublishOptions} from 'mqtt/types/lib/client-options';

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

const maxBodySize = 1024 * 1024;
const updateAfterIntervalMs = 1000 * util.getNumericEnv('WATER_UPDATE_INTERVAL', 900);

let updateInterval: NodeJS.Timeout;

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
  log.i(`Got signal ${signal}. Stopping.`);
  process.exit(0);
}

let mqttClient: mqtt.MqttClient;

async function start() {
  log.i(`Logging into MQTT server ${mqttEndpoint}`);

  await util.runWithRetry(() => {
    mqttClient = mqtt.connect(mqttEndpoint, {
      username: mqttUsername,
      password: mqttPassword,
    });

    return Promise.resolve();
  }, null, 60000);


  log.i(`Logged into MQTT server ${mqttEndpoint}`);

  while (true) {
    await updateStats();
    await util.waitFor(15 * 60);
  }
}

async function updateStats() {
  const parsedWaterEndpointUrl = new URL(waterApiEndpoint);

  log.i(`Fetching water data`);
  const response = await util.httpMakeRequest({
                                                protocol: parsedWaterEndpointUrl.protocol,
                                                hostname: parsedWaterEndpointUrl.hostname,
                                                port: parsedWaterEndpointUrl.port,
                                                path: `${parsedWaterEndpointUrl.pathname}?format=json,1.1&site=${siteIds}`,
                                              }, '');
  const body: string = await util.readStreamAsString(response.responseBodyStream, maxBodySize);
  const json: any = JSON.parse(body);
  const timeSeries: any[] = json.value.timeSeries;
  const publishData: any = {};

  log.i(`USGS Data: ${JSON.stringify(json, null, 2)}`);
  log.i(`Publishing water data to MQTT`);

  const promises: Promise<mqtt.Packet>[] = [];

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
    promises.push(publishMqtt(mqttClient, getAttributesTopic(siteId), {
      latitude: geolocation.latitude,
      longitude: geolocation.longitude,
      datum: geolocation.srs,
    }, {
      retain: true
    }));
  }

  util.forEachOwned(publishData, (siteId: string, publishSiteData: any) => {
    promises.push(publishMqtt(mqttClient, getStateTopic(siteId), publishSiteData, { retain: true }));
  });

  await Promise.all(promises);

  log.i(`Published to MQTT`);
}

function getConfigTopic(siteId: string, variable: string): string {
  return `${mqttTopicBase}/${siteId}/${variable}/config`;
}

function getStateTopic(siteId: string): string {
  return `${mqttTopicBase}/${siteId}/state`;
}

function getAttributesTopic(siteId: string): string {
  return `${mqttTopicBase}/${siteId}/attributes`;
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

    mqttClient.publish(
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

start();
