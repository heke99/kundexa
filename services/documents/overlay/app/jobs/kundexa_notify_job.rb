# frozen_string_literal: true
require 'net/http'

class KundexaNotifyJob
  include Sidekiq::Job
  sidekiq_options retry: 12

  def perform(submission_id, event_id)
    url = ENV['KUNDEXA_CALLBACK_URL']
    return if url.blank?
    uri = URI.parse(url)
    raise ArgumentError, 'https_callback_required' unless uri.scheme == 'https'
    body = { submission_id:, event_id: }.to_json
    timestamp = Time.now.to_i.to_s
    secret = ENV.fetch('KUNDEXA_DOCUMENTS_SECRET')
    signature = OpenSSL::HMAC.hexdigest('SHA256', secret, timestamp + '.' + body)
    request = Net::HTTP::Post.new(uri)
    request['Content-Type'] = 'application/json'
    request['X-Kundexa-Documents-Timestamp'] = timestamp
    request['X-Kundexa-Documents-Signature'] = signature
    request.body = body
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 10, read_timeout: 30) { |http| http.request(request) }
    raise "callback_http_#{response.code}" unless response.is_a?(Net::HTTPSuccess)
  end
end
