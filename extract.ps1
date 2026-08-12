$word = New-Object -ComObject Word.Application
$word.Visible = $false

$doc1 = $word.Documents.Open("c:\Users\wise_gtr\Downloads\THE ATI APP\PRE-TRAINING TEST MASWALI NA MAJIBU.doc")
$doc1.Content.Text | Out-File -FilePath "c:\Users\wise_gtr\Downloads\THE ATI APP\pre-training-test.txt" -Encoding UTF8
$doc1.Close()

$doc2 = $word.Documents.Open("c:\Users\wise_gtr\Downloads\THE ATI APP\ANNEX I Training Participants and Facilitators(2).docx")
$doc2.Content.Text | Out-File -FilePath "c:\Users\wise_gtr\Downloads\THE ATI APP\participants.txt" -Encoding UTF8
$doc2.Close()

$word.Quit()
Write-Host "Done extracting documents"
