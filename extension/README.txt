Photo Organizer helper (add-on for Chrome and Edge)
===================================================

What it does
  Lets the Photo Organizer app (https://mateiuc.github.io/photo-organizer/) read your
  Google Photos library through your own signed-in Google Photos tab, the same way the
  Google Photos website does. Nothing is downloaded and nothing is sent anywhere else.
  It lists your photos and videos, their details and albums, and searches them the way
  the Google Photos search box does.
  Since version 0.3.0 it can also move photos you choose in the app to Google Photos'
  own Trash (and bring them back). That only happens after you confirm in the app.
  Google Photos keeps trashed items for 60 days, so they can be restored from
  photos.google.com > Trash. Nothing is deleted for good.

Install (once)
  1. Unzip this folder somewhere you will keep it, for example
     Documents\Photo Organizer helper. Don't delete the folder afterwards.
  2. Open chrome://extensions (in Edge: edge://extensions).
  3. Switch on "Developer mode".
  4. Click "Load unpacked" and choose this folder (the one with manifest.json in it).
  5. Reload the Photo Organizer page, open "Choose photos", and click
     "Read my Google Photos".

Update to a new version
  1. Unzip the new version over the old folder (replace the files).
  2. Open chrome://extensions and click the reload button (circular arrow) on
     "Photo Organizer helper".
  3. Reload the Photo Organizer page.

Good to know
  - Be signed in to photos.google.com in the same browser.
  - If no Google Photos tab is open, the add-on opens one in the background.
    Leave it open while the app works.
  - To remove the add-on: chrome://extensions, then Remove.

The way it talks to Google Photos follows Google Photos Toolkit by xob0t (MIT licence):
https://github.com/xob0t/google-photos-toolkit
