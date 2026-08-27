' Silent launcher: runs the relay keep-alive loop with no console window.
' Put a shortcut to this file (or a copy that points at this folder) in the
' Startup folder: shell:startup
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\start-relay.ps1""", 0, False
