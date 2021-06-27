'use strict';

const dotenv = require('dotenv').config();
const fs = require('fs');
const puppeteer = require('puppeteer');
const axios = require("axios");

const DEFAULT_CONTINUOUS_POLL_AFTER_ENROLLMENT_OPENS_SECONDS = 300;
const DEFAULT_CONTINUOUS_POLL_BEFORE_ENROLLMENT_OPENS_SECONDS = 300;
const DEFAULT_POLL_PERIOD_SECONDS = 60;
const DEFAULT_RESET_PERIOD_SECONDS = 3600;
const SCREENSHOT_FILE_PATH = 'enrolled.png';
const VIEW_HEIGHT = 768;
const VIEW_WIDTH = 1024;
const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'
];
const WODIFY_CALENDAR_BANNER_NOTIFICATION_ID =
    'AthleteTheme_wt6_block_RichWidgets_wt28_block_wtSanitizedHtml3';
const WODIFY_CALENDAR_CLASS_ALREADY_ENROLLED_CLASS = 'icon-ticket';
const WODIFY_CALENDAR_CLASS_ENROLL_CLASS = 'icon-calendar';
const WODIFY_CALENDAR_CLASS_FULL_SUBSTRING = 'waitlist';
const WODIFY_CALENDAR_CLASS_UNAVAILABLE_CLASS = 'icon-calendar--disabled';
const WODIFY_CALENDAR_LOAD_TIMEOUT_MILLISECONDS = 20 * 1000;
const WODIFY_CALENDAR_LOAD_TIMEOUT_RETRY_DELAY_MILLISECONDS = 5 * 1000;
const WODIFY_CALENDAR_LOADING_BANNER_ID =
    'AthleteTheme_wt6_block_wt11_RichWidgets_wt3_block_wtdivWait';
const WODIFY_CALENDAR_RESET_BUTTON_ID =
    'AthleteTheme_wt6_block_wtMainContent_wt9_wt12';
const WODIFY_CALENDAR_TABLE_ID =
    'AthleteTheme_wt6_block_wtMainContent_wt9_wtClassTable';
const WODIFY_CALENDAR_URI =
    'https://app.wodify.com/Schedule/CalendarListView.aspx';
const WODIFY_LOGIN_FORM_ID = 'form[id="FormLogin"]';
const WODIFY_LOGIN_PASSWORD_INPUT_ID = 'input[id="Input_Password"]';
const WODIFY_LOGIN_SUBMIT_BUTTON_ID = 'button[type="submit"]';
const WODIFY_LOGIN_URI = 'https://app.wodify.com/SignIn/Login';
const WODIFY_LOGIN_USERNAME_INPUT_ID = 'input[id="Input_UserName"]';


function log(message = '') {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function capitalize(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

async function logIn(page, loginUri, config, credentials) {
  await page.goto(loginUri);
  await page.waitForSelector(config.formId);
  await page.type(config.usernameInputId, credentials.username);
  await page.type(config.passwordInputId, credentials.password);
  await page.click(config.submitButtonId);
  await page.waitForNavigation();
}

async function getDesiredOpenClasses(page, config) {
  return await page.evaluate((WEEKDAYS, config) => {
    const desiredClassWeekdays =
        Object.keys(config.enrollList).map(key => key.toLowerCase());
    let weekday = undefined;
    let desiredOpenClasses = [];
    const rows = document.querySelectorAll(`#${config.tableId} tr`);
    for (const row of rows) {
      const dateOrClassNameColumn = row.querySelector('td');
      if (dateOrClassNameColumn === null) continue;
      const newWeekday = WEEKDAYS.find(weekday => {
        return dateOrClassNameColumn.innerText.toLowerCase().includes(weekday);
      });
      if (newWeekday !== undefined) {
        weekday = newWeekday;
        continue;
      }
      if (!desiredClassWeekdays.includes(weekday)) continue;

      const columns = row.querySelectorAll('td');
      // clang-format off
      const [classColumn, reservationStatusColumn, enrollActionColumn,
          cancelActionColumn, programColumn, gymLocationColumn, startTimeColumn,
          durationColumn, coachColumn] = columns;
      // clang-format on

      const program = programColumn.innerText.toLowerCase();
      const startTime = startTimeColumn.innerText.toLowerCase();

      const desiredStartTime = config.enrollList[weekday]['time'].toLowerCase();
      const desiredProgram =
          config.enrollList[weekday]['program'].toLowerCase();

      if (!(startTime.trim().toLowerCase() === desiredStartTime &&
            program.toLowerCase().includes(desiredProgram))) {
        continue;
      }

      const unavailableSelector =
          `.${config.wodifyCalendarClassUnavailableClass}`;
      const alreadyEnrolledSelector =
          `.${config.wodifyCalendarClassAlreadyEnrolledClass}`;
      const enrollSelector = `.${config.wodifyCalendarClassEnrollClass}`;
      if (enrollActionColumn.querySelector(unavailableSelector) !== null ||
          enrollActionColumn.querySelector(alreadyEnrolledSelector) !== null ||
          enrollActionColumn.querySelector(enrollSelector) === null) {
        continue;
      }

      const enrollAction = enrollActionColumn.querySelector('a');
      if (enrollAction === null) continue;
      const classFull = enrollAction.title.toLowerCase().includes(
          config.wodifyCalendarClassFullSubstring);
      if (classFull) continue;

      desiredOpenClasses.push({
        weekday: weekday,
        time: startTime,
        program: program,
        enrollActionId: enrollAction.id.toString(),
      });
    }
    return desiredOpenClasses;
  }, WEEKDAYS, config);
}

async function sendEnrolledNotification(enrolledClasses, gotifyURL) {
  const classPlurality = enrolledClasses.length == 1 ? '' : 'es';
  let message = `Registered in the following Wodify class${classPlurality}:\n`;
  enrolledClasses.forEach(enrolledClass => {
    message += `Time: ${capitalize(enrolledClass.weekday)} at ${
        enrolledClass.time.toUpperCase()}\n`;
    message += `Program: ${capitalize(enrolledClass.program)}\n`;
  });
  message += '\n';
  message += `Verify your registration: ${WODIFY_CALENDAR_URI}`;
  const bodyFormData = {
    title: "New Wodify class registration",
    message: message,
    priority: 5,
  };
  await axios({
    method: "post",
    headers: {
      "Content-Type": "application/json",
    },
    url: gotifyURL,
    data: bodyFormData,
  }).then((response) => console.log(response.data))
    .catch((err) => console.log(err.response ? error.response.data : err));
}

async function sendErrorNotification(error, gotifyURL) {
  await mailgun.messages().send(email);
  const bodyFormData = {
    title: "Wodify class enroller failed",
    message: `Oh snap! Wodify Class Enroller encountered an error: ${error}`,
    priority: 5,
  };
  await axios({
    method: "post",
    headers: {
      "Content-Type": "application/json",
    },
    url: gotifyURL,
    data: bodyFormData,
  }).then((response) => console.log(response.data))
    .catch((err) => console.log(err.response ? error.response.data : err));
}

async function run(
    wodifyCredentials, enrollList, pollPeriodMilliseconds,
    resetPeriodMilliseconds, enrollmentOpeningBeforeClassMilliseconds,
    continuousPollBeforeEnrollmentOpensMilliseconds,
    continuousPollAfterEnrollmentOpensMilliseconds, gotifyURL) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({width: VIEW_WIDTH, height: VIEW_HEIGHT});
  page.on('console', consoleObj => {
    if (consoleObj.type() === 'log') {
        console.log(consoleObj.text());
    }
  })

  const loginConfig = {
    formId: WODIFY_LOGIN_FORM_ID,
    usernameInputId: WODIFY_LOGIN_USERNAME_INPUT_ID,
    passwordInputId: WODIFY_LOGIN_PASSWORD_INPUT_ID,
    submitButtonId: WODIFY_LOGIN_SUBMIT_BUTTON_ID,
  };
  log('Logging into Wodify...');
  await logIn(page, WODIFY_LOGIN_URI, loginConfig, wodifyCredentials);
  log('Logged in.');

  let firstVisit = true;
  const waitOptions = {
    timeout: WODIFY_CALENDAR_LOAD_TIMEOUT_MILLISECONDS,
    waitUntil: ['networkidle0', 'domcontentloaded']
  };
  const enrollConfig = {
    tableId: WODIFY_CALENDAR_TABLE_ID,
    weekdays: WEEKDAYS,
    wodifyCalendarClassUnavailableClass:
        WODIFY_CALENDAR_CLASS_UNAVAILABLE_CLASS,
    wodifyCalendarClassAlreadyEnrolledClass:
        WODIFY_CALENDAR_CLASS_ALREADY_ENROLLED_CLASS,
    wodifyCalendarClassEnrollClass: WODIFY_CALENDAR_CLASS_ENROLL_CLASS,
    wodifyCalendarClassFullSubstring: WODIFY_CALENDAR_CLASS_FULL_SUBSTRING,
    enrollList: enrollList,
  };

  let lastResetDate = new Date();
  while (true) {
    log('Checking available classes...');
    let startDate = new Date();

    try {
      if (firstVisit) {
        await page.goto(WODIFY_CALENDAR_URI, waitOptions);
        lastResetDate = startDate;
      } else {
        await page.reload(waitOptions);
      }
    } catch (error) {
      log(`Failed to load page: ${error}`);
      log(`Waiting ${
          WODIFY_CALENDAR_LOAD_TIMEOUT_RETRY_DELAY_MILLISECONDS /
          1000} seconds to try again.`);
      await new Promise(
          resolve => {setTimeout(
              resolve, WODIFY_CALENDAR_LOAD_TIMEOUT_RETRY_DELAY_MILLISECONDS)});
      continue;
    }
    firstVisit = false;

    if (resetPeriodMilliseconds <
        startDate.getTime() - lastResetDate.getTime()) {
      log('Resetting filters...');
      lastResetDate = startDate;
      await page.click(`#${WODIFY_CALENDAR_RESET_BUTTON_ID}`);
      await page.waitForSelector(
          `#${WODIFY_CALENDAR_LOADING_BANNER_ID}`, {visible: true});
      await page.waitForSelector(
          `#${WODIFY_CALENDAR_LOADING_BANNER_ID}`, {hidden: true});
      log('Reset filters.');
    }

    const desiredOpenClasses = await getDesiredOpenClasses(page, enrollConfig);
    log(`${desiredOpenClasses.length} desired classes available.`);
    for (const desiredClass of desiredOpenClasses) {
      log(`Attempting to enroll in ${capitalize(desiredClass.weekday)}'s ${
          desiredClass.time.toUpperCase()} ${
          capitalize(desiredClass.program)} class...`);
      await page.click(`#${desiredClass.enrollActionId}`);
      await page.waitForSelector(`#${WODIFY_CALENDAR_BANNER_NOTIFICATION_ID}`);
    }
    if (0 < desiredOpenClasses.length) {
      log(`Finished attemting to enroll in ${
          desiredOpenClasses.length} desired open classes.`);
      await page.screenshot({path: SCREENSHOT_FILE_PATH, fullPage: true});
    }

    if (0 < desiredOpenClasses.length) {
      log('Sending notification...');
      try {
        await sendEnrolledNotification(desiredOpenClasses, gotifyURL);
        log('Sent notification.');
      } catch (error) {
        log(`Failed to send notification: ${error}`);
      }
    }

    const endDate = new Date();
    const millisecondsUntilNextCheck = (() => {
      const elapsedTime = endDate.getTime() - startDate.getTime();
      const defaultDelayMilliseconds = pollPeriodMilliseconds - elapsedTime;
      const eligibleEnrollmentDate = new Date(
          endDate.getTime() + enrollmentOpeningBeforeClassMilliseconds);
      const weekday = WEEKDAYS[eligibleEnrollmentDate.getDay()];
      const enrollInfo = enrollList[weekday];
      if (enrollInfo === undefined) return defaultDelayMilliseconds;
      const classDate = (() => {
        const timePattern = /(\d{1,2})\:(\d\d)\s(a|p)m/;
        const classTime = enrollInfo['time'].toLowerCase().match(timePattern);
        const afternoonClass = classTime[3] === 'p';
        const classHours =
            (parseInt(classTime[1]) % 12) + (afternoonClass ? 12 : 0);
        const classMinutes = parseInt(classTime[2]);
        let date = new Date(eligibleEnrollmentDate);
        date.setHours(classHours);
        date.setMinutes(classMinutes);
        date.setSeconds(0);
        return date;
      })();
      const minContinuousPollDate = new Date(
          classDate.getTime() -
          continuousPollBeforeEnrollmentOpensMilliseconds);
      const maxContinuousPollDate = new Date(
          classDate.getTime() + continuousPollAfterEnrollmentOpensMilliseconds);
      if (minContinuousPollDate < eligibleEnrollmentDate &&
          eligibleEnrollmentDate < maxContinuousPollDate) {
        return 0;
      }
      const nextOffsetPollDate =
          new Date(eligibleEnrollmentDate.getTime() + defaultDelayMilliseconds);
      if (eligibleEnrollmentDate < minContinuousPollDate &&
          minContinuousPollDate < nextOffsetPollDate) {
        return minContinuousPollDate.getTime() -
            eligibleEnrollmentDate.getTime();
      }
      return defaultDelayMilliseconds;
    })();
    log(`Waiting ${
        millisecondsUntilNextCheck /
        1000} seconds to check class availability again.`);
    await new Promise(
        resolve => {setTimeout(resolve, millisecondsUntilNextCheck)});
  }

  await browser.close();
}

(async () => {
  const args = process.argv;
  const usage = `Usage: ${args[0]} ${args[1]} <enroll_list.json>`
  if (args.length != 3) {
    console.log(usage);
    process.exit(1);
  }
  const helpArg = args[2].toLowerCase();
  if (helpArg === 'help' || helpArg === '--help' || helpArg === '-h') {
    console.log(usage);
    process.exit(0);
  }
  const enrollListFile = args[2];

  const wodifyUsername = process.env.WODIFY_USERNAME;
  const wodifyPassword = process.env.WODIFY_PASSWORD;
  const gotifyURL = process.env.GOTIFY_URL;
  const pollPeriodMilliseconds =
      (process.env.POLL_PERIOD_SECONDS || DEFAULT_POLL_PERIOD_SECONDS) * 1000;
  const resetPeriodMilliseconds =
      (process.env.RESET_PERIOD_SECONDS || DEFAULT_RESET_PERIOD_SECONDS) * 1000;
  const enrollmentOpeningBeforeClassMinutes =
      process.env.ENROLLMENT_OPENING_BEFORE_CLASS_MINUTES;
  const continuousPollBeforeEnrollmentOpensMilliseconds =
      (process.env.CONTINUOUS_POLL_BEFORE_ENROLLMENT_OPENS_SECONDS ||
       DEFAULT_CONTINUOUS_POLL_BEFORE_ENROLLMENT_OPENS_SECONDS) *
      1000;
  const continuousPollAfterEnrollmentOpensMilliseconds =
      (process.env.CONTINUOUS_POLL_AFTER_ENROLLENT_OPENS_SECONDS ||
       DEFAULT_CONTINUOUS_POLL_AFTER_ENROLLMENT_OPENS_SECONDS) *
      1000;

  const enrollList = JSON.parse(fs.readFileSync(enrollListFile));

  if (wodifyUsername === undefined) {
    console.log('Missing Wodify username.');
    process.exit(1);
  }
  if (wodifyPassword === undefined) {
    console.log('Missing Wodify password.');
    process.exit(1);
  }
  const wodifyCredentials = {
    username: wodifyUsername,
    password: wodifyPassword,
  };

  if (gotifyURL === undefined) {
    console.log('Missing Gotify URL.');
    process.exit(1);
  }

  if (enrollmentOpeningBeforeClassMinutes === undefined) {
    console.log('Missing enrollment opening time before class.');
    process.exit(1);
  }
  const enrollmentOpeningBeforeClassMilliseconds =
      enrollmentOpeningBeforeClassMinutes * 60 * 1000;

  try {
    run(wodifyCredentials, enrollList,
        pollPeriodMilliseconds, resetPeriodMilliseconds,
        enrollmentOpeningBeforeClassMilliseconds,
        continuousPollBeforeEnrollmentOpensMilliseconds,
        continuousPollAfterEnrollmentOpensMilliseconds, gotifyURL);
  } catch (error) {
    sendErrorNotification(error, gotifyURL);
  }
})();
