@echo off

git log -1

echo.
echo "------------------------"
echo.

echo git status
git status


echo.
echo "###############################"
echo.




:: Get last commit message
for /f "delims=" %%i in ('git log -1 --pretty^=%%B') do set LASTMSG=%%i

:: New commit message from args
set NEWMSG=%*

:: Compare
if "%NEWMSG%"=="%LASTMSG%" (
    echo Commit rejected: message is identical to the last commit.
    echo Last commit message: "%LASTMSG%"
    exit /b 1
)

if "%~1"=="" (
  echo Please provide a commit message.
  echo Example: gcommit.bat "added mixpanel tracking"
  exit /b 1
)

echo git status
git status

echo git add .
git add .

echo git commit -m "%NEWMSG%"
git commit -m "%NEWMSG%"

echo git push
git push
