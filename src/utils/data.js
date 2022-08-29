const optionKeys = [
  'loadEnglishChallenge',
  'tryEnglishSpeechModel',
  'simulateUserInput',
  'autoUpdateClientApp',
  'navigateWithKeyboard'
];

const clientAppPlatforms = [
  'windows/amd64',
  'windows/386',
  'linux/amd64',
  'macos/amd64'
];

const recaptchaChallengeUrlRx = /^https:\/\/www\.(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/bframe.*/;

export {
  optionKeys,
  clientAppPlatforms,
  recaptchaChallengeUrlRx
};
