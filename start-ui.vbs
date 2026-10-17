' start-ui.vbs - launch the wb-ssh connection manager with no console window.
'
' Double-click this file (or start-ui.cmd, which forwards here): the server
' starts hidden, the browser opens on the page, and no terminal window is left
' lying around. Everything the server would have printed to that window goes to
' ui.log next to this file instead -- a hidden launch has no console to print to.
'
' To stop the server, run stop-ui.cmd.
' To watch the output live while troubleshooting, run start-ui-debug.cmd.

Option Explicit

Dim shell, fso, here, logFile, rotated, command, code, quote

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
quote = Chr(34)

here = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = fso.BuildPath(here, "ui.log")

' node must be on PATH. Say so out loud when it is not: a hidden window would
' swallow the error and leave the user staring at nothing at all.
code = shell.Run("cmd /c where node >nul 2>nul", 0, True)
If code <> 0 Then
  MsgBox "找不到 node.exe。" & vbCrLf & vbCrLf & _
         "请先安装 Node.js（18 或更高版本），或确认它已加入 PATH。" & vbCrLf & _
         "启动目录：" & here, 16, "wb-ssh connection manager"
  WScript.Quit 1
End If

' One generation of rotation, so a long-running hidden server cannot grow its
' log without bound. The audit trail lives in activity.jsonl, not here.
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 1048576 Then
    rotated = logFile & ".1"
    If fso.FileExists(rotated) Then fso.DeleteFile rotated, True
    fso.MoveFile logFile, rotated
  End If
End If

shell.CurrentDirectory = here

' 0 = hidden window, False = do not wait. The server opens the browser itself
' as soon as it is listening, which is the only feedback a hidden launch gives.
command = "cmd /c node ui.mjs --port 7812 --host 0.0.0.0 >> " & quote & logFile & quote & " 2>&1"
shell.Run command, 0, False
