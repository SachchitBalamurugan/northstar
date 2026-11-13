# Runs the kit's "Done =" checks against running services. Usage: .\scripts\smoke.ps1
$ErrorActionPreference = "Continue"
function Check($name, $block) {
  try { $r = & $block; Write-Host ("PASS  {0}  {1}" -f $name, $r) -ForegroundColor Green }
  catch { Write-Host ("FAIL  {0}  {1}" -f $name, $_.Exception.Message) -ForegroundColor Red }
}
$M = "http://127.0.0.1:7701"; $I = "http://127.0.0.1:7702"
Check "memory /health"  { (Invoke-RestMethod "$M/health").service }
Check "inbox  /health"  { (Invoke-RestMethod "$I/health").service }
Check "memory /insights < 200ms" {
  $sw = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-RestMethod "$M/insights"; $sw.Stop()
  if ($sw.ElapsedMilliseconds -gt 200) { throw "took $($sw.ElapsedMilliseconds)ms" }
  "$($sw.ElapsedMilliseconds)ms  next: $($r.nextThing.title) — $($r.nextThing.why)"
}
Check "memory /context Prof. Lee" {
  $r = Invoke-RestMethod -Method Post "$M/context" -ContentType "application/json" -Body '{"query":"Prof. Lee"}'
  $k = ($r.knowledge | Where-Object file -eq "people.md").content
  if (-not ($k -match "Lee")) { throw "people.md not returned" }
  ($k -split "`n" | Select-String "Lee" | Select-Object -First 1).ToString().Trim()
}
Check "inbox  /sync"    { $r = Invoke-RestMethod -Method Post "$I/sync"; "emails=$($r.emails) events=$($r.events) triaged=$($r.triaged)" }
Check "inbox  /triage <= 5 needsYou" {
  $r = Invoke-RestMethod "$I/triage"
  if ($r.needsYou.Count -gt 5) { throw "needsYou=$($r.needsYou.Count)" }
  "needsYou=$($r.needsYou.Count) fyi=$($r.fyi.Count) ignored=$($r.ignored); top: $($r.needsYou[0].subject)"
}
Check "inbox  /deadlines" { $r = Invoke-RestMethod "$I/deadlines"; "$($r.Count) deadlines; first: $($r[0].title) due $($r[0].dueAt)" }
Check "inbox  /schedule/plan blocks in 14-17" {
  $r = Invoke-RestMethod -Method Post "$I/schedule/plan" -ContentType "application/json" -Body '{}'
  if ($r.Count -eq 0) { throw "no proposals" }
  $hours = $r | ForEach-Object { ([datetime]$_.payload.block.start).Hour }
  "$($r.Count) blocks; start hours: $($hours -join ',')"
}
Check "inbox  /draft sounds like Maya" {
  $t = Invoke-RestMethod "$I/triage"; $id = $t.needsYou[0].emailId
  $r = Invoke-RestMethod -Method Post "$I/draft" -ContentType "application/json" -Body "{`"emailId`":`"$id`"}"
  if ($r.type -ne "send_reply") { throw "type=$($r.type)" }
  "'$($r.title)' -> " + ($r.payload.body -split "`n" | Select-Object -Last 2) -join " "
}
Check "pending proposals merge" {
  $a = Invoke-RestMethod "$M/proposals?status=pending"; $b = Invoke-RestMethod "$I/proposals?status=pending"
  "memory=$($a.Count) inbox=$($b.Count)"
}
