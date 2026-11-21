# Work Recovery S1.8: lokales Expo-Modul (autolinked aus ./modules).
Pod::Spec.new do |s|
  s.name           = 'BackupExclusion'
  s.version        = '1.0.0'
  s.summary        = 'Excludes TaskOps recovery export files from iOS backups'
  s.description    = 'Sets and reads back NSURLIsExcludedFromBackupKey for recovery export files.'
  s.license        = 'UNLICENSED'
  s.author         = 'TaskOps'
  s.homepage       = 'https://github.com/FerasHB/cleaning-ops-app'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/FerasHB/cleaning-ops-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = '**/*.{h,m,swift}'
end
