# frozen_string_literal: true
Rails.application.config.after_initialize do
  Rails.application.routes.prepend do
    post '/kundexa/templates', to: 'kundexa/templates#create'
    post '/kundexa/templates/:id/snapshot', to: 'kundexa/templates#snapshot'
    get '/kundexa/templates/:id/edit', to: 'kundexa/builder#show'
    patch '/kundexa/templates/:id', to: 'kundexa/builder#update'
    put '/kundexa/templates/:id', to: 'kundexa/builder#update'
    post '/kundexa/submissions', to: 'kundexa/submissions#create'
  end
  Template.before_update do
    if preferences_was['kundexa_locked'] && (fields_changed? || schema_changed? || submitters_changed? || preferences['kundexa_locked'] != true)
      raise ActiveRecord::ReadOnlyRecord, 'approved_template_is_immutable'
    end
  end
  Submission.after_update_commit do
    if previous_changes.key?('completed_at') || previous_changes.key?('expire_at')
      KundexaNotifyJob.perform_async(id, "submission:#{id}:#{updated_at.to_i}")
    end
  end
end
