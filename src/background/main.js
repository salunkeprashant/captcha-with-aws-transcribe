import browser from 'webextension-polyfill';
import audioBufferToWav from 'audiobuffer-to-wav';
import aes from 'crypto-js/aes';
import sha256 from 'crypto-js/sha256';
import utf8 from 'crypto-js/enc-utf8';

import {initStorage} from 'storage/storage';
import storage from 'storage/storage';
import {
  showNotification,
  sendNativeMessage
} from 'utils/app';
import {
  executeCode,
  executeFile,
  scriptsAllowed,
  functionInContext,
  getBrowser,
  getPlatform,
  normalizeAudio,
  sliceAudio
} from 'utils/common';
import {
  recaptchaChallengeUrlRx} from 'utils/data';
import {targetEnv, clientAppVersion} from 'utils/config';

import { TranscribeClient, StartTranscriptionJobCommand, Transcribe } from "@aws-sdk/client-transcribe";
import {S3, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3RequestPresigner } from"@aws-sdk/s3-request-presigner";
import { createRequest } from"@aws-sdk/util-create-request";
import { formatUrl } from"@aws-sdk/util-format-url";

const config = {
  region: String,
  credentials: {
    accessKeyId: String,
    secretAccessKey: String
  }
};

let transcribeClient = null;
let transcribeService = null;
let s3Client = null;

let retryCount = 0;
let nativePort;
let secrets;

function getFrameClientPos(index) {
  let currentIndex = -1;
  if (window !== window.top) {
    const siblingWindows = window.parent.frames;
    for (let i = 0; i < siblingWindows.length; i++) {
      if (siblingWindows[i] === window) {
        currentIndex = i;
        break;
      }
    }
  }

  const targetWindow = window.frames[index];
  for (const frame of document.querySelectorAll('iframe')) {
    if (frame.contentWindow === targetWindow) {
      let {left: x, top: y} = frame.getBoundingClientRect();
      const scale = window.devicePixelRatio;

      return {x: x * scale, y: y * scale, currentIndex};
    }
  }
}

async function getFramePos(tabId, frameId, frameIndex) {
  let x = 0;
  let y = 0;

  while (true) {
    frameId = (
      await browser.webNavigation.getFrame({
        tabId,
        frameId
      })
    ).parentFrameId;
    if (frameId === -1) {
      break;
    }

    const [data] = await executeCode(
      `(${getFrameClientPos.toString()})(${frameIndex})`,
      tabId,
      frameId
    );

    frameIndex = data.currentIndex;
    x += data.x;
    y += data.y;
  }

  return {x, y};
}

async function resetCaptcha(tabId, frameId, challengeUrl) {
  frameId = (
    await browser.webNavigation.getFrame({
      tabId,
      frameId: frameId
    })
  ).parentFrameId;

  if (!(await scriptsAllowed(tabId, frameId))) {
    await showNotification({messageId: 'error_scriptsNotAllowed'});
    return;
  }

  if (!(await functionInContext('addListener', tabId, frameId))) {
    await executeFile('/src/content/initReset.js', tabId, frameId);
  }
  await executeCode('addListener()', tabId, frameId);

  await browser.tabs.sendMessage(
    tabId,
    {
      id: 'resetCaptcha',
      challengeUrl
    },
    {frameId}
  );
}

function challengeRequestCallback(details) {
  const url = new URL(details.url);
  if (url.searchParams.get('hl') !== 'en') {
    url.searchParams.set('hl', 'en');
    return {redirectUrl: url.toString()};
  }
}

async function setChallengeLocale() {
  const {loadEnglishChallenge, simulateUserInput} = await storage.get(
    ['loadEnglishChallenge', 'simulateUserInput'],
    'sync'
  );

  if (loadEnglishChallenge || simulateUserInput) {
    if (
      !browser.webRequest.onBeforeRequest.hasListener(challengeRequestCallback)
    ) {
      browser.webRequest.onBeforeRequest.addListener(
        challengeRequestCallback,
        {
          urls: [
            'https://www.google.com/recaptcha/api2/anchor*',
            'https://www.google.com/recaptcha/api2/bframe*',
            'https://www.recaptcha.net/recaptcha/api2/anchor*',
            'https://www.recaptcha.net/recaptcha/api2/bframe*',
            'https://recaptcha.net/recaptcha/api2/anchor*',
            'https://recaptcha.net/recaptcha/api2/bframe*',
            'https://www.google.com/recaptcha/enterprise/anchor*',
            'https://www.google.com/recaptcha/enterprise/bframe*',
            'https://www.recaptcha.net/recaptcha/enterprise/anchor*',
            'https://www.recaptcha.net/recaptcha/enterprise/bframe*',
            'https://recaptcha.net/recaptcha/enterprise/anchor*',
            'https://recaptcha.net/recaptcha/enterprise/bframe*'
          ],
          types: ['sub_frame']
        },
        ['blocking']
      );
    }
  } else if (
    browser.webRequest.onBeforeRequest.hasListener(challengeRequestCallback)
  ) {
    browser.webRequest.onBeforeRequest.removeListener(challengeRequestCallback);
  }
}

function removeRequestOrigin(details) {
  const origin = window.location.origin;
  const headers = details.requestHeaders;
  for (const header of headers) {
    if (header.name.toLowerCase() === 'origin' && header.value === origin) {
      headers.splice(headers.indexOf(header), 1);
      break;
    }
  }

  return {requestHeaders: headers};
}

function addBackgroundRequestListener() {
  if (
    !browser.webRequest.onBeforeSendHeaders.hasListener(removeRequestOrigin)
  ) {
    const urls = [
      'https://www.google.com/*',
      'https://www.recaptcha.net/*',
      'https://recaptcha.net/*',
    ];

    const extraInfo = ['blocking', 'requestHeaders'];
    if (
      targetEnv !== 'firefox' &&
      Object.values(browser.webRequest.OnBeforeSendHeadersOptions).includes(
        'extraHeaders'
      )
    ) {
      extraInfo.push('extraHeaders');
    }

    browser.webRequest.onBeforeSendHeaders.addListener(
      removeRequestOrigin,
      {
        urls,
        types: ['xmlhttprequest']
      },
      extraInfo
    );
  }
}

function removeBackgroundRequestListener() {
  if (browser.webRequest.onBeforeSendHeaders.hasListener(removeRequestOrigin)) {
    browser.webRequest.onBeforeSendHeaders.removeListener(removeRequestOrigin);
  }
}

async function prepareAudio(audio) {
  const audioBuffer = await normalizeAudio(audio);

  const audioSlice = await sliceAudio({
    audioBuffer,
    start: 1.5,
    end: audioBuffer.duration - 1.5
  });

  return audioBufferToWav(audioSlice);
}

async function loadSecrets() {
  try {
    const ciphertext = await (await fetch('/secrets.txt')).text();

    const key = sha256(
      (await (await fetch('/src/background/script.js')).text()) +
        (await (await fetch('/src/solve/script.js')).text())
    ).toString();

    secrets = JSON.parse(aes.decrypt(ciphertext, key).toString(utf8));
  } catch (err) {
    secrets = {};
    const {speechService} = await storage.get('speechService', 'sync');
    if (speechService === 'witSpeechApiDemo') {
      await storage.set({speechService: 'witSpeechApi'}, 'sync');
    }
  }
}

async function getAwsTrascribeApiResult(audioContent) {

  const key = `captcha-transcribe-job-${Math.floor(Date.now() / 1000)}`;
  const signedUrl = await createPresignedUrl(key);
  const response = await putAudioInBucket(signedUrl, audioContent);

  const command = new StartTranscriptionJobCommand({
    TranscriptionJobName: key,
    // The language code for the input audio. Valid values are en-GB, en-US, es-US, fr-CA, and fr-FR.
    LanguageCode: "en-US",
    // The encoding used for the input audio. The only valid value is pcm.
    Media: {
      MediaFileUri:  "s3://demo-awstranscribe/" + key + '.wav',
      // For example, "https://transcribe-demo.s3-REGION.amazonaws.com/hello_world.wav"
    }
  });

  const JobResult = await transcribeClient.send(command);
  await sleep(10000);
  retryCount = 0;
  const solution = await getTranscriptWithRetry(command.input.TranscriptionJobName);
  return solution;
}

async function getTranscriptWithRetry(jobName) {
  const result = await transcribeService.getTranscriptionJob({ TranscriptionJobName: jobName });

  if (result.TranscriptionJob.TranscriptionJobStatus === 'COMPLETED') {
    if (result.TranscriptionJob?.Transcript?.TranscriptFileUri) {
      const jsonResult = await (await fetch(result.TranscriptionJob?.Transcript?.TranscriptFileUri)).json();
      console.log(jsonResult);
      return jsonResult.results.transcripts[0].transcript;
    }
  } else {
    if (retryCount <= 3) {
      retryCount++;
      await sleep(5000);
      return await getTranscriptWithRetry(jobName);
    } else {
      console.log('Retry exceeded...');
      showNotification({ messageId: 'error_internalError' });
      return null;
    }
  }
}

async function createPresignedUrl(key){
  // Create a presigned URL to upload the transcription to the Amazon S3 bucket when it is ready.
  try {
    // Create an Amazon S3RequestPresigner object.
    const signer = new S3RequestPresigner({...s3Client.config});
    // Create the request.
    const request = await createRequest(
      s3Client,
      new PutObjectCommand({ Key: key + '.wav', Bucket: 'demo-awstranscribe' })
    );
    // Define the duration until expiration of the presigned URL.
    const expiration = new Date(Date.now() + 60 * 60 * 1000);
    // Create and format the presigned URL.
    let signedUrl;
    signedUrl = formatUrl(await signer.presign(request, expiration));
    console.log(`\nPutting "${key}"`);
    return signedUrl;
  } catch (err) {
    console.log("Error creating presigned URL", err);
  }
}

async function putAudioInBucket(signedUrl, audioContent) {
  let response;
  try {
    response = await fetch(signedUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream'
      },
      body: new Blob([audioContent], {type: 'audio/wav'})
    });
  } catch (e) {
    console.log('Error in putAudioInBucket', err);
  }

  return response;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transcribeAudio(audioUrl, lang) {
  let solution;

  const audioRsp = await fetch(audioUrl, {referrer: ''});
  const audioContent = await prepareAudio(await audioRsp.arrayBuffer());

  if (!secrets) {
    await loadSecrets();
    config.region = secrets.region;
    config.credentials.accessKeyId = secrets.accessKeyId;
    config.credentials.secretAccessKey = secrets.secretAccessKey;

    transcribeClient = new TranscribeClient(config);
    transcribeService = new Transcribe(config);
    s3Client = new S3(config);
  }

  solution = await getAwsTrascribeApiResult(audioContent);

  if (!solution) {
    showNotification({messageId: 'error_captchaNotSolved', timeout: 6000});
  } else {
    return solution;
  }
}

async function onMessage(request, sender) {
  if (request.id === 'notification') {
    showNotification({
      message: request.message,
      messageId: request.messageId,
      title: request.title,
      type: request.type,
      timeout: request.timeout
    });
  } else if (request.id === 'captchaSolved') {
    let {useCount} = await storage.get('useCount', 'sync');
    useCount += 1;
    await storage.set({useCount}, 'sync');
  } else if (request.id === 'transcribeAudio') {
    addBackgroundRequestListener();
    try {
      return await transcribeAudio(request.audioUrl, request.lang);
    } finally {
      removeBackgroundRequestListener();
    }
  } else if (request.id === 'resetCaptcha') {
    await resetCaptcha(sender.tab.id, sender.frameId, request.challengeUrl);
  } else if (request.id === 'getFramePos') {
    return getFramePos(sender.tab.id, sender.frameId, request.frameIndex);
  } else if (request.id === 'getTabZoom') {
    return browser.tabs.getZoom(sender.tab.id);
  } else if (request.id === 'getBackgroundScriptScale') {
    return window.devicePixelRatio;
  } else if (request.id === 'startClientApp') {
    nativePort = browser.runtime.connectNative('org.buster.client');
  } else if (request.id === 'stopClientApp') {
    if (nativePort) {
      nativePort.disconnect();
    }
  } else if (request.id === 'messageClientApp') {
    const message = {
      apiVersion: clientAppVersion,
      ...request.message
    };
    return sendNativeMessage(nativePort, message);
  } else if (request.id === 'openOptions') {
    browser.runtime.openOptionsPage();
  } else if (request.id === 'getPlatform') {
    return getPlatform();
  } else if (request.id === 'getBrowser') {
    return getBrowser();
  }
}

async function onStorageChange(changes, area) {
  await setChallengeLocale();
}

function addStorageListener() {
  browser.storage.onChanged.addListener(onStorageChange);
}

function addMessageListener() {
  browser.runtime.onMessage.addListener(onMessage);
}

async function onInstall(details) {
  if (
    ['chrome', 'edge', 'opera'].includes(targetEnv) &&
    ['install', 'update'].includes(details.reason)
  ) {
    const tabs = await browser.tabs.query({
      url: ['http://*/*', 'https://*/*'],
      windowType: 'normal'
    });

    for (const tab of tabs) {
      const tabId = tab.id;

      const frames = await browser.webNavigation.getAllFrames({tabId});
      for (const frame of frames) {
        const frameId = frame.frameId;

        if (frameId && recaptchaChallengeUrlRx.test(frame.url)) {
          await browser.tabs.insertCSS(tabId, {
            frameId,
            runAt: 'document_idle',
            file: '/src/solve/reset-button.css'
          });

          await browser.tabs.executeScript(tabId, {
            frameId,
            runAt: 'document_idle',
            file: '/src/manifest.js'
          });
          await browser.tabs.executeScript(tabId, {
            frameId,
            runAt: 'document_idle',
            file: '/src/solve/script.js'
          });
        }
      }
    }
  }
}

async function onLoad() {
  await initStorage('local');
  await setChallengeLocale();
  addStorageListener();
  addMessageListener();
}

browser.runtime.onInstalled.addListener(onInstall);

document.addEventListener('DOMContentLoaded', onLoad);
